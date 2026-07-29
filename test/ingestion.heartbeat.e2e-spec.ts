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
import { INGESTION_LEASE_CONFIG } from '../src/ingestion/ingestion.service';
import {
  EMBEDDINGS,
  type EmbeddingsProvider,
} from '../src/embeddings/embeddings.types';
import { waitForProcessing, waitForStatus } from './support/wait-for-source';

// A directory distinct from every other spec file's source URI: Jest runs
// spec files in separate workers against the same live database, and
// sharing a `sources.uri` value would make their status-transition and
// unique-constraint behavior race each other. (This bit ingestion.e2e-spec.ts
// and ingestion.concurrency.e2e-spec.ts fine since they use different paths
// from each other — the mistake here was reusing concurrency's `nested`
// path, which a full `npm run test:e2e` run caught immediately.)
const SOURCE = path.resolve(__dirname, 'fixtures/heartbeat-only');

// Tiny values so this file proves the heartbeat/lease interplay in
// milliseconds instead of the real 15-minute window. Production defaults
// (DEFAULT_INGESTION_LEASE_CONFIG) are untouched; only this test's own app
// instance overrides them, via the same DI token EMBEDDINGS already uses.
const TEST_LEASE_MS = 300;
const TEST_HEARTBEAT_INTERVAL_MS = 50;
// Comfortably longer than TEST_LEASE_MS: without a heartbeat renewing the
// lease, a competing claim attempted after holding this long would succeed.
const HOLD_MS = 900;

/**
 * Blocks every `embed()` call until `release()` is invoked. Reset to open
 * before/after every test so no test depends on another one's cleanup —
 * the same pattern ingestion.concurrency.e2e-spec.ts uses.
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

describe('ingestion lease heartbeat', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(gatedEmbeddings)
      .overrideProvider(INGESTION_LEASE_CONFIG)
      .useValue({
        leaseMs: TEST_LEASE_MS,
        heartbeatIntervalMs: TEST_HEARTBEAT_INTERVAL_MS,
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    db = moduleRef.get<Kysely<DB>>(KYSELY);
  });

  afterEach(async () => {
    gate = Promise.resolve();
    await db.deleteFrom('sources').where('uri', '=', SOURCE).execute();
  });

  afterAll(async () => {
    await app.close();
  });

  it("a live pipeline's heartbeat keeps a competing request from reclaiming it, even past what would otherwise be a stale lease", async () => {
    const release = closeGate();

    const first = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: SOURCE })
      .expect(202);
    const { sourceId } = first.body as { sourceId: string };

    // markProcessing runs before the first embed() call, and embed() is
    // gated shut, so the pipeline is guaranteed to still be sitting here —
    // genuinely alive, just paused, exactly like a slow embedding call.
    await waitForProcessing(app.getHttpServer(), sourceId);

    // Hold it there for longer than the lease. Without a heartbeat
    // renewing updated_at during the pause, this alone would make the row
    // look dead to a competing claim.
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));

    const second = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: SOURCE });

    expect(second.status).toBe(409);

    release();

    const ready = await waitForStatus(app.getHttpServer(), sourceId, 'ready');
    expect(ready.status).toBe('ready');
  });

  it('still reclaims a row whose heartbeat has genuinely stopped', async () => {
    const repository = app.get(IngestionRepository);

    // No pipeline is running against this row at all — nothing renews its
    // lease — so aging it past the (tiny, for this file) lease window is
    // indistinguishable from a run whose process is actually gone.
    const staleId = await repository.createSource(SOURCE, 'docs');
    await db
      .updateTable('sources')
      .set({
        status: 'processing',
        updated_at: new Date(Date.now() - HOLD_MS),
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
});
