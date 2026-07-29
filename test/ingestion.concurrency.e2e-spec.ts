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
import { IngestionRepository } from '../src/ingestion/ingestion.repository';
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
 * Blocks every `embed()` call until `release()` is invoked. The gate is a
 * mutable module-level reference reset to "already open" before every test,
 * so a test that never touches it (or is run alone via `-t`/`.only`) never
 * blocks on a gate nobody released — only the one test that explicitly
 * closes its own gate needs to remember to release it.
 */
let gate: Promise<void> = Promise.resolve();

function closeGate(): () => void {
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

const gatedEmbeddings: EmbeddingsProvider = {
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

describe('concurrent ingestion requests', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(gatedEmbeddings)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    db = moduleRef.get<Kysely<DB>>(KYSELY);
  });

  beforeEach(() => {
    // Reset to open regardless of what the previous test left behind, so
    // this file's tests (and any single one run in isolation) never depend
    // on another test's cleanup having run first.
    gate = Promise.resolve();
  });

  afterEach(async () => {
    gate = Promise.resolve();
    await db.deleteFrom('sources').where('uri', '=', SOURCE).execute();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a second post while the first is still processing, rather than starting a duplicate pipeline', async () => {
    const release = closeGate();

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

    release();

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

  it('reclaims a stranded processing row once its lease has gone stale', async () => {
    const repository = app.get(IngestionRepository);

    // Simulates a run interrupted long enough ago that it cannot possibly
    // still be alive — a crash, a `Ctrl-C`, a dropped connection — rather
    // than one merely working through a slow document.
    const staleId = await repository.createSource(SOURCE, 'docs');
    await db
      .updateTable('sources')
      .set({
        status: 'processing',
        updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .where('id', '=', staleId)
      .execute();

    const reclaimed = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: SOURCE });

    expect(reclaimed.status).toBe(202);
    expect((reclaimed.body as { sourceId: string }).sourceId).toBe(staleId);

    const ready = await waitForStatus(app.getHttpServer(), staleId, 'ready');
    expect(ready.status).toBe('ready');
  });

  it('never runs two pipelines against the same already-ready source', async () => {
    // Get a genuinely `ready` source to race a re-ingestion against — the
    // scenario a non-atomic "read status, then write" check gets wrong: two
    // concurrent requests can both read `ready` before either one writes
    // `processing`.
    const first = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: SOURCE })
      .expect(202);
    const firstId = (first.body as { sourceId: string }).sourceId;
    await waitForStatus(app.getHttpServer(), firstId, 'ready');

    const [a, b] = await Promise.all([
      request(app.getHttpServer()).post('/ingest').send({ source: SOURCE }),
      request(app.getHttpServer()).post('/ingest').send({ source: SOURCE }),
    ]);

    expect(a.status).not.toBe(500);
    expect(b.status).not.toBe(500);
    expect([202, 409]).toContain(a.status);
    expect([202, 409]).toContain(b.status);

    const accepted = [a, b].find((response) => response.status === 202);

    if (!accepted) {
      throw new Error('expected one of the two concurrent posts to succeed');
    }

    const { sourceId } = accepted.body as { sourceId: string };
    expect(sourceId).toBe(firstId);

    const ready = await waitForStatus(app.getHttpServer(), sourceId, 'ready');
    expect(ready.status).toBe('ready');

    // The failure mode a non-atomic check allows: two pipelines both
    // writing means the denormalised counter and the actual rows can
    // disagree, or the second pipeline can hit a genuine duplicate-key
    // error partway through. Counting the real rows catches either.
    const { count } = await db
      .selectFrom('chunks')
      .innerJoin('documents', 'documents.id', 'chunks.document_id')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('documents.source_id', '=', sourceId)
      .executeTakeFirstOrThrow();

    expect(Number(count)).toBeGreaterThan(0);
    expect(Number(count)).toBe(Number(ready.chunk_count));
  });
});
