import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { Server } from 'node:http';

import { AppModule } from '../src/app.module';
import { KYSELY } from '../src/common/database/database.module';
import { CHUNK_EMBEDDING_DIMENSIONS } from '../src/common/database/schema';
import type { DB } from '../src/common/database/schema';
import { RetrievalRepository } from '../src/retrieval/retrieval.repository';

const vector = (seed: number): number[] =>
  Array.from(
    { length: CHUNK_EMBEDDING_DIMENSIONS },
    (_v, i) => ((seed + i) % 100) / 100,
  );

describe('retrieval repository', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;
  let repository: RetrievalRepository;
  let readySourceId: string;
  let failedSourceId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get<Kysely<DB>>(KYSELY);
    repository = app.get(RetrievalRepository);

    readySourceId = await seedSource('ready', 'retrieval-ready', 1);
    failedSourceId = await seedSource('failed', 'retrieval-failed', 2);
  });

  afterAll(async () => {
    await db
      .deleteFrom('sources')
      .where('id', 'in', [readySourceId, failedSourceId])
      .execute();
    await app.close();
  });

  async function seedSource(
    status: string,
    uri: string,
    seed: number,
  ): Promise<string> {
    const source = await db
      .insertInto('sources')
      .values({ uri, type: 'docs', status })
      .returning('id')
      .executeTakeFirstOrThrow();

    const document = await db
      .insertInto('documents')
      .values({ source_id: source.id, path: `${uri}.md`, title: uri })
      .returning('id')
      .executeTakeFirstOrThrow();

    await sql`
      INSERT INTO chunks (document_id, ordinal, content, heading_path, token_count, embedding)
      VALUES (
        ${document.id}, 0,
        ${`unmistakable marker ${uri} about ValidationPipe`},
        ARRAY['Root', 'Leaf'], 10,
        ${`[${vector(seed).join(',')}]`}::vector
      )
    `.execute(db);

    return source.id;
  }

  it('finds a chunk lexically by a term it contains', async () => {
    const results = await repository.searchByText(
      'unmistakable marker retrieval-ready',
      10,
    );

    expect(results.map((r) => r.documentPath)).toContain('retrieval-ready.md');
  });

  it('never returns a chunk whose source is not ready', async () => {
    const results = await repository.searchByText(
      'unmistakable marker retrieval-failed',
      10,
    );

    expect(results.map((r) => r.documentPath)).not.toContain(
      'retrieval-failed.md',
    );
  });

  it('returns an empty list for a question sharing no lexeme with the corpus', async () => {
    const results = await repository.searchByText('zzzqqq wwwvvv', 10);

    expect(results).toEqual([]);
  });

  it('does not throw on a question that is only stopwords', async () => {
    await expect(repository.searchByText('the of and a', 10)).resolves.toEqual(
      [],
    );
  });

  it('does not throw on hostile tsquery input', async () => {
    await expect(
      repository.searchByText(`! & | ( ) <-> ' " foo:*A`, 10),
    ).resolves.toBeDefined();
  });

  it('finds chunks by vector similarity', async () => {
    const results = await repository.searchByVector(vector(1), 5);

    expect(results.length).toBeGreaterThan(0);
  });

  it('excludes non-ready sources from vector search too', async () => {
    const results = await repository.searchByVector(vector(2), 100);

    expect(results.map((r) => r.documentPath)).not.toContain(
      'retrieval-failed.md',
    );
  });

  it('carries heading path through', async () => {
    const results = await repository.searchByText(
      'unmistakable marker retrieval-ready',
      10,
    );

    expect(results[0]?.headingPath).toEqual(['Root', 'Leaf']);
  });
});
