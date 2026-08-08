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
import { IngestionRepository } from '../src/ingestion/ingestion.repository';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { waitForStatus } from './support/wait-for-source';
import { listenOnEphemeralPort } from './support/listening-app';

const FIXTURES = path.resolve(__dirname, 'fixtures/corpus');

/**
 * Deterministic stand-in: a vector derived from the text's length, so the same
 * input always yields the same output and no API is called.
 */
const stubEmbeddings: EmbeddingsProvider = {
  embed: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        Array.from(
          { length: CHUNK_EMBEDDING_DIMENSIONS },
          (_v, i) => ((text.length + i) % 100) / 100,
        ),
      ),
    ),
};

describe('ingestion', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(stubEmbeddings)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await listenOnEphemeralPort(app);
    db = moduleRef.get<Kysely<DB>>(KYSELY);
  });

  afterEach(async () => {
    await db.deleteFrom('sources').where('uri', '=', FIXTURES).execute();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a source and reports it ready with its chunks', async () => {
    const accepted = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: FIXTURES })
      .expect(202);

    const { sourceId } = accepted.body as { sourceId: string };
    const source = await waitForStatus(app.getHttpServer(), sourceId, 'ready');

    expect(source.status).toBe('ready');
    expect(source.document_count).toBe(4);
    expect(Number(source.chunk_count)).toBeGreaterThan(0);
  });

  it('leaves no @@switch or @@filename markers in stored content', async () => {
    const accepted = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: FIXTURES })
      .expect(202);

    const { sourceId } = accepted.body as { sourceId: string };
    const source = await waitForStatus(app.getHttpServer(), sourceId, 'ready');
    expect(source.status).toBe('ready');

    const rows = await db
      .selectFrom('chunks')
      .innerJoin('documents', 'documents.id', 'chunks.document_id')
      .select('chunks.content')
      .where('documents.source_id', '=', sourceId)
      .execute();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.content).not.toContain('@@switch');
      expect(row.content).not.toContain('@@filename');
      expect(row.content).not.toContain('app-banner');
    }
  });

  it('omits metadata entirely when every filename directive in a document is bare', async () => {
    const accepted = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: FIXTURES })
      .expect(202);

    const { sourceId } = accepted.body as { sourceId: string };
    const source = await waitForStatus(app.getHttpServer(), sourceId, 'ready');
    expect(source.status).toBe('ready');

    // pipes.md's only `@@filename()` directive is bare (Nest's "no
    // dedicated file" marker), so the filtered, per-document filename list
    // is empty and every one of its chunks should carry no metadata at all
    // — not `{ filenames: [''] }`.
    const rows = await db
      .selectFrom('chunks')
      .innerJoin('documents', 'documents.id', 'chunks.document_id')
      .select('chunks.metadata')
      .where('documents.source_id', '=', sourceId)
      .where('documents.path', '=', 'pipes.md')
      .execute();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.metadata).toEqual({});
    }
  });

  it('replaces previous content instead of duplicating on re-ingestion', async () => {
    const first = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: FIXTURES })
      .expect(202);
    const firstId = (first.body as { sourceId: string }).sourceId;
    const afterFirst = await waitForStatus(
      app.getHttpServer(),
      firstId,
      'ready',
    );
    expect(afterFirst.status).toBe('ready');
    expect(Number(afterFirst.chunk_count)).toBeGreaterThan(0);

    const second = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: FIXTURES })
      .expect(202);
    const secondId = (second.body as { sourceId: string }).sourceId;
    const afterSecond = await waitForStatus(
      app.getHttpServer(),
      secondId,
      'ready',
    );
    expect(afterSecond.status).toBe('ready');
    expect(secondId).toBe(firstId);

    // The denormalised counter alone would still pass this test even if a
    // repository bug reset it without deleting the underlying rows; count
    // the actual chunk rows through their document instead.
    const { count } = await db
      .selectFrom('chunks')
      .innerJoin('documents', 'documents.id', 'chunks.document_id')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('documents.source_id', '=', secondId)
      .executeTakeFirstOrThrow();

    expect(Number(count)).toBeGreaterThan(0);
    expect(Number(count)).toBe(Number(afterFirst.chunk_count));
  });

  it('never pairs a ready status with zeroed counts while resetting a source for re-ingestion', async () => {
    const repository = app.get(IngestionRepository);
    const embedding = Array.from(
      { length: CHUNK_EMBEDDING_DIMENSIONS },
      () => 0.1,
    );

    const id = await repository.createSource(FIXTURES, 'docs');
    await repository.insertDocumentWithChunks(
      id,
      { path: 'a.md', title: 'A' },
      [
        {
          ordinal: 0,
          content: 'one',
          headingPath: ['A'],
          tokenCount: 1,
          embedding,
          metadata: {},
        },
      ],
    );
    await repository.markReady(id);

    const ready = await repository.findSource(id);
    expect(ready?.status).toBe('ready');
    expect(Number(ready?.chunk_count)).toBeGreaterThan(0);

    // This is the exact order IngestionService's reuse path uses: the claim
    // flips status off its terminal value before the counts are cleared, so
    // no reader — polling over HTTP or querying the table directly — can
    // ever observe a 'ready' row whose content has already been wiped. (The
    // claim's own atomicity — that two concurrent callers can't both win —
    // is exercised over HTTP in ingestion.concurrency.e2e-spec.ts; this test
    // is scoped to the ordering of the two writes, not the race between two
    // callers making them.)
    const claimed = await repository.claimForProcessing(id, new Date());
    expect(claimed?.status).not.toBe('ready');

    await repository.deleteSourceContent(id);
    const afterDelete = await repository.findSource(id);
    expect(afterDelete?.status).not.toBe('ready');
    expect(afterDelete?.chunk_count).toBe(0);
  });

  it('fails the whole source when a document collides at the database, instead of counting it as skipped', async () => {
    const repository = app.get(IngestionRepository);
    const service = app.get(IngestionService);

    const id = await repository.createSource(FIXTURES, 'docs');

    // Pre-seed a row that collides with one of the fixture files on the
    // (source_id, path) constraint, so inserting it raises a genuine
    // database error rather than a markdown-parsing one. 'guards.md' sorts
    // first among the fixtures, so this is also the first document
    // runPipeline reaches.
    await db
      .insertInto('documents')
      .values({ source_id: id, path: 'guards.md', title: 'pre-existing' })
      .execute();

    let caught: unknown;
    try {
      await service.runPipeline(id, FIXTURES, '**/*.md');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();

    const source = await repository.findSource(id);
    expect(source?.status).toBe('failed');
    expect(source?.error).toBeTruthy();
    expect(source?.chunk_count).toBe(0);
  });

  it('records a failed source for an unusable path', async () => {
    const accepted = await request(app.getHttpServer())
      .post('/ingest')
      .send({ source: './relative/path' })
      .expect(202);

    const { sourceId } = accepted.body as { sourceId: string };
    const source = await waitForStatus(app.getHttpServer(), sourceId, 'ready');

    expect(source.status).toBe('failed');
    expect(String(source.error)).toMatch(/absolute/i);

    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
  });

  it('rejects a request with no source field', async () => {
    await request(app.getHttpServer()).post('/ingest').send({}).expect(400);
  });
});
