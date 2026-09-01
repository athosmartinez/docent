import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Kysely, sql } from 'kysely';
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
import { listenOnEphemeralPort } from './support/listening-app';

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
    await listenOnEphemeralPort(app);
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
    // Anchored on the database's own clock, the same one `reuse()` computes
    // `staleBefore` from — not the application's `Date.now()`. The two can
    // disagree (see the skewed-clock test below for how far), and aging this
    // row from the wrong clock would make the margin between "reclaimed" and
    // "still live" a function of host/database clock drift rather than of
    // HOLD_MS itself, exactly the defect this file exists to guard against.
    const dbNow = await repository.databaseNow();
    await db
      .updateTable('sources')
      .set({
        status: 'processing',
        updated_at: new Date(dbNow.getTime() - HOLD_MS),
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

  // The staleness threshold (`reuse()` in ingestion.service.ts) is computed
  // from `repository.databaseNow()`, the same clock every `updated_at`
  // write already uses — not from the application's `Date.now()`. A wildly
  // wrong application clock is what makes the two distinguishable: with the
  // old `Date.now()`-based threshold, faking the clock far into the future
  // pushes `staleBefore` far past this row's real, moments-old `updated_at`,
  // making a genuinely live lease look expired and letting a second request
  // reclaim it out from under a (hypothetically) still-running pipeline. Only
  // Date is faked — every real timer stays real, so the request's own HTTP
  // round trip and the app's internal timers are unaffected (see the sibling
  // clock test in ingestion.repository.e2e-spec.ts for why that matters).
  it('a skewed application clock does not make a genuinely live lease look expired', async () => {
    const repository = app.get(IngestionRepository);

    const freshId = await repository.createSource(SOURCE, 'docs');
    // Fresh by the database's own clock, well inside TEST_LEASE_MS — no
    // pipeline actually running against it keeps the test simple, but what
    // matters is that this lease has not gone stale.
    await db
      .updateTable('sources')
      .set({ status: 'processing', updated_at: sql`now()` })
      .where('id', '=', freshId)
      .execute();

    jest.useFakeTimers({
      now: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
      ],
    });

    let response;
    try {
      response = await request(app.getHttpServer())
        .post('/ingest')
        .send({ source: SOURCE });
    } finally {
      jest.useRealTimers();
    }

    expect(response.status).toBe(409);
  });
});
