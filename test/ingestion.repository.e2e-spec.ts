import { Test } from '@nestjs/testing';
import { Kysely, sql } from 'kysely';

import { AppConfigModule } from '../src/common/config/config.module';
import { DatabaseModule, KYSELY } from '../src/common/database/database.module';
import type { DB } from '../src/common/database/schema';
import { IngestionRepository } from '../src/ingestion/ingestion.repository';

describe('IngestionRepository', () => {
  let repository: IngestionRepository;
  let db: Kysely<DB>;
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
  >;

  const uri = 'test://ingestion-repository';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [IngestionRepository],
    }).compile();

    repository = moduleRef.get(IngestionRepository);
    db = moduleRef.get<Kysely<DB>>(KYSELY);
  });

  afterEach(async () => {
    await db.deleteFrom('sources').where('uri', '=', uri).execute();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('creates a source in the pending state', async () => {
    const id = await repository.createSource(uri, 'docs');
    const source = await repository.findSource(id);

    expect(source?.status).toBe('pending');
    expect(source?.uri).toBe(uri);
  });

  it('stores chunks and reads the embedding back as the vector it wrote', async () => {
    const id = await repository.createSource(uri, 'docs');
    const embedding = Array.from({ length: 3072 }, (_v, i) => (i % 10) / 10);

    await repository.insertDocumentWithChunks(
      id,
      { path: 'guards.md', title: 'Guards' },
      [
        {
          ordinal: 0,
          content: 'guards protect routes',
          headingPath: ['Guards', 'Authorization guard'],
          tokenCount: 4,
          embedding,
          metadata: { filename: 'auth.guard' },
        },
      ],
    );

    const row = await db
      .selectFrom('chunks')
      .innerJoin('documents', 'documents.id', 'chunks.document_id')
      .select([
        'chunks.content',
        'chunks.heading_path',
        'chunks.embedding',
        'chunks.metadata',
      ])
      .where('documents.source_id', '=', id)
      .executeTakeFirstOrThrow();

    expect(row.heading_path).toEqual(['Guards', 'Authorization guard']);
    expect(row.metadata).toEqual({ filename: 'auth.guard' });
    expect(row.embedding.startsWith('[')).toBe(true);
  });

  it('generates a searchable full-text column from chunk content', async () => {
    const id = await repository.createSource(uri, 'docs');

    await repository.insertDocumentWithChunks(
      id,
      { path: 'guards.md', title: 'Guards' },
      [
        {
          ordinal: 0,
          content: 'guards protect routes from unauthorized requests',
          headingPath: ['Guards'],
          tokenCount: 6,
          embedding: Array.from({ length: 3072 }, () => 0.1),
          metadata: {},
        },
      ],
    );

    // content_tsv is a PostgreSQL GENERATED column, absent from the DB interface
    // because application code never writes it, so this asserts through raw SQL —
    // using the same @@ full-text-match operator a query against it would use.
    const result = await sql<{ matched: string }>`
      SELECT c.id AS matched
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.source_id = ${id}::uuid
        AND c.content_tsv @@ plainto_tsquery('english', 'unauthorized requests')
    `.execute(db);

    expect(result.rows).toHaveLength(1);
  });

  it('updates counts as documents land', async () => {
    const id = await repository.createSource(uri, 'docs');

    await repository.insertDocumentWithChunks(
      id,
      { path: 'a.md', title: 'A' },
      [
        {
          ordinal: 0,
          content: 'one',
          headingPath: ['A'],
          tokenCount: 1,
          embedding: Array.from({ length: 3072 }, () => 0.1),
          metadata: {},
        },
        {
          ordinal: 1,
          content: 'two',
          headingPath: ['A'],
          tokenCount: 1,
          embedding: Array.from({ length: 3072 }, () => 0.2),
          metadata: {},
        },
      ],
    );

    const source = await repository.findSource(id);

    expect(source?.document_count).toBe(1);
    expect(source?.chunk_count).toBe(2);
  });

  it('removes documents and chunks when the source content is cleared', async () => {
    const id = await repository.createSource(uri, 'docs');

    await repository.insertDocumentWithChunks(
      id,
      { path: 'a.md', title: 'A' },
      [
        {
          ordinal: 0,
          content: 'one',
          headingPath: ['A'],
          tokenCount: 1,
          embedding: Array.from({ length: 3072 }, () => 0.1),
          metadata: {},
        },
      ],
    );

    await repository.deleteSourceContent(id);

    const remaining = await db
      .selectFrom('documents')
      .select('id')
      .where('source_id', '=', id)
      .execute();
    const source = await repository.findSource(id);

    expect(remaining).toEqual([]);
    expect(source?.document_count).toBe(0);
    expect(source?.chunk_count).toBe(0);
  });

  it('records a failure with its message', async () => {
    const id = await repository.createSource(uri, 'docs');

    await repository.markFailed(id, 'ECONNREFUSED reaching the remote');

    const source = await repository.findSource(id);

    expect(source?.status).toBe('failed');
    expect(source?.error).toContain('ECONNREFUSED');
  });

  // CorpusVersion's soundness rests on a newly-ready source's updated_at
  // exceeding every other ready source's — true under one monotonic clock,
  // not guaranteed under two. A test comparing the written timestamp against
  // the real wall clock would not catch a regression back to `new Date()`:
  // on the same machine the application and database clocks are normally
  // within milliseconds of each other, so both would pass. Faking the
  // application's clock far away from the real time is what makes the two
  // distinguishable — if this write used `new Date()`, updated_at would land
  // in 1999; every other write in this file shares the identical
  // `sql`now()`` expression, so this one write stands for all of them.
  it("sets updated_at from Postgres's clock, not the application's", async () => {
    const id = await repository.createSource(uri, 'docs');

    // Fakes only Date — every real timer stays real, so the shared
    // connection pool's own idle/keepalive timeouts (used by every other
    // suite running concurrently against this same pool) are unaffected.
    jest.useFakeTimers({
      now: new Date('1999-01-01T00:00:00.000Z'),
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
    try {
      await repository.markReady(id);
    } finally {
      jest.useRealTimers();
    }

    const source = await repository.findSource(id);
    const secondsSinceRealNow =
      (Date.now() - (source?.updated_at.getTime() ?? 0)) / 1000;

    expect(source?.status).toBe('ready');
    expect(secondsSinceRealNow).toBeLessThan(60);
  });
});
