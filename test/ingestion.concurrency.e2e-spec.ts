import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Kysely } from 'kysely';
import * as path from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';

import { AppModule } from '../src/app.module';
import { KYSELY } from '../src/common/database/database.module';
import type { DB } from '../src/common/database/schema';
import { CHUNK_EMBEDDING_DIMENSIONS } from '../src/common/database/schema';
import {
  EMBEDDINGS,
  type EmbeddingsProvider,
} from '../src/embeddings/embeddings.types';
import { waitForProcessing, waitForStatus } from './support/wait-for-source';

// A directory distinct from the one test/ingestion.e2e-spec.ts uses as its
// source URI: both files can run in separate Jest workers against the same
// live database, and sharing a `sources.uri` value across files would make
// their unique-constraint and status-transition behavior race each other.
const SOURCE = path.resolve(__dirname, 'fixtures/corpus/nested');

/**
 * Blocks every `embed()` call until `release()` is invoked, then stays open
 * for the rest of the suite (a resolved promise resolves instantly on every
 * further `await`). This holds a pipeline in `processing` on demand, which
 * is what makes the "second request while running" scenario deterministic
 * instead of a timing gamble.
 */
function createGatedEmbeddings(): {
  provider: EmbeddingsProvider;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const provider: EmbeddingsProvider = {
    embed: async (texts) => {
      await gate;

      return texts.map((text) =>
        Array.from(
          { length: CHUNK_EMBEDDING_DIMENSIONS },
          (_v, i) => ((text.length + i) % 100) / 100,
        ),
      );
    },
  };

  return { provider, release };
}

describe('concurrent ingestion requests', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;
  let releaseGate: () => void;

  beforeAll(async () => {
    const gated = createGatedEmbeddings();
    releaseGate = gated.release;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(gated.provider)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    db = moduleRef.get<Kysely<DB>>(KYSELY);
  });

  afterEach(async () => {
    await db.deleteFrom('sources').where('uri', '=', SOURCE).execute();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a second post while the first is still processing, rather than starting a duplicate pipeline', async () => {
    const first = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: SOURCE })
      .expect(202);
    const { sourceId } = first.body as { sourceId: string };

    // markProcessing runs before the first embed() call, and embed() is
    // gated shut, so the pipeline is guaranteed to still be sitting here.
    await waitForProcessing(app.getHttpServer(), sourceId);

    const second = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: SOURCE });

    expect(second.status).toBe(409);

    releaseGate();

    const ready = await waitForStatus(app.getHttpServer(), sourceId, 'ready');
    expect(ready.status).toBe('ready');
  });

  it('never returns 500 for two concurrent posts of the same brand-new source', async () => {
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post('/ingest').send({ source: SOURCE }),
      request(app.getHttpServer()).post('/ingest').send({ source: SOURCE }),
    ]);

    // Exactly one request's insert wins the race on `sources.uri`; the
    // other either observes the row already running (409) or, having lost
    // the read race too, reuses it (202). Either is a valid outcome — a raw
    // 500 from an unhandled constraint violation is the only wrong one.
    expect(first.status).not.toBe(500);
    expect(second.status).not.toBe(500);
    expect([202, 409]).toContain(first.status);
    expect([202, 409]).toContain(second.status);

    const accepted = [first, second].find(
      (response) => response.status === 202,
    );

    if (!accepted) {
      throw new Error('expected one of the two concurrent posts to succeed');
    }

    const { sourceId } = accepted.body as { sourceId: string };
    const ready = await waitForStatus(app.getHttpServer(), sourceId, 'ready');
    expect(ready.status).toBe('ready');
  });
});
