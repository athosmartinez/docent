import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { Server } from 'node:http';

import { AppModule } from '../src/app.module';
import { KYSELY } from '../src/common/database/database.module';
import type { DB } from '../src/common/database/schema';
import { AskRepository } from '../src/ask/ask.repository';

describe('ask repository', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;
  let repository: AskRepository;
  let sourceId: string;
  let chunkId: string;
  // Populated only by tests whose transaction actually commits, so cleanup
  // can delete exactly the queries this suite produced instead of the whole
  // table — the rollback test commits nothing, and contributes no id here.
  const createdAnswerIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get<Kysely<DB>>(KYSELY);
    repository = app.get(AskRepository);

    const source = await db
      .insertInto('sources')
      .values({ uri: 'ask-repo-fixture', type: 'docs', status: 'ready' })
      .returning('id')
      .executeTakeFirstOrThrow();
    sourceId = source.id;

    const document = await db
      .insertInto('documents')
      .values({ source_id: sourceId, path: 'fixture.md', title: 'Fixture' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const chunk = await sql<{ id: string }>`
      INSERT INTO chunks (document_id, ordinal, content, token_count)
      VALUES (${document.id}, 0, 'fixture chunk', 5)
      RETURNING id
    `.execute(db);

    const first = chunk.rows[0];
    if (!first) throw new Error('fixture chunk was not inserted');
    chunkId = first.id;
  });

  afterAll(async () => {
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();

    // Scoped to the answers this suite actually created: an unqualified
    // DELETE FROM queries would also remove any other suite's fixtures that
    // happen to share the table when tests run with parallel workers.
    if (createdAnswerIds.length > 0) {
      const owned = await db
        .selectFrom('answers')
        .select('query_id')
        .where('id', 'in', createdAnswerIds)
        .execute();

      const queryIds = owned.map((row) => row.query_id);
      if (queryIds.length > 0) {
        await db.deleteFrom('queries').where('id', 'in', queryIds).execute();
      }
    }

    await app.close();
  });

  it('records a grounded answer with its citations', async () => {
    const answerId = await repository.record({
      question: 'a question',
      answer: 'an answer [1]',
      grounded: true,
      model: 'gpt-4.1-mini',
      provider: 'openai',
      finishReason: 'stop',
      citations: [
        {
          ordinal: 1,
          chunkId,
          path: 'fixture.md',
          headingPath: [],
          score: 0.5,
        },
      ],
    });

    createdAnswerIds.push(answerId);

    const citations = await db
      .selectFrom('citations')
      .selectAll()
      .where('answer_id', '=', answerId)
      .execute();

    expect(citations).toHaveLength(1);
    expect(citations[0]?.chunk_id).toBe(chunkId);

    const answer = await db
      .selectFrom('answers')
      .selectAll()
      .where('id', '=', answerId)
      .executeTakeFirstOrThrow();

    expect(answer.grounded).toBe(true);
    expect(answer.model).toBe('gpt-4.1-mini');
    expect(answer.provider).toBe('openai');
    expect(answer.finish_reason).toBe('stop');
  });

  it('records a refusal with no citations and a null answer', async () => {
    const answerId = await repository.record({
      question: 'something out of corpus',
      answer: null,
      grounded: false,
      model: null,
      provider: null,
      finishReason: null,
      citations: [],
    });

    createdAnswerIds.push(answerId);

    const answer = await db
      .selectFrom('answers')
      .selectAll()
      .where('id', '=', answerId)
      .executeTakeFirstOrThrow();

    expect(answer.grounded).toBe(false);
    expect(answer.answer).toBeNull();
  });

  it('writes query and answer in one transaction', async () => {
    // A citation pointing at a chunk that does not exist violates the foreign
    // key, and must leave no orphan query behind.
    const before = await db
      .selectFrom('queries')
      .select(db.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();

    await expect(
      repository.record({
        question: 'doomed',
        answer: 'x',
        grounded: true,
        model: 'm',
        provider: 'openai',
        finishReason: 'stop',
        citations: [
          {
            ordinal: 1,
            chunkId: '00000000-0000-0000-0000-000000000000',
            path: 'nowhere.md',
            headingPath: [],
            score: 0.1,
          },
        ],
      }),
    ).rejects.toThrow();

    const after = await db
      .selectFrom('queries')
      .select(db.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();

    expect(after.n).toEqual(before.n);
  });
});
