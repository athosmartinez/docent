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

  it('populates the generated full-text column so M2 can search it', async () => {
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

    // content_tsv is absent from the DB interface because application code never
    // writes it, so this asserts through raw SQL — which is also the closest
    // thing to how M2 will query it.
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
});
