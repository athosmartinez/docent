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

  it('writes exactly one cost_ledger row, joined to the created query, with usd_cost parsed back as a number', async () => {
    const answerId = await repository.record({
      question: 'a costed question',
      answer: 'an answer [1]',
      grounded: true,
      model: 'gpt-4.1-mini',
      provider: 'openai',
      finishReason: 'stop',
      citations: [],
      cost: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: 10,
        usdCost: 0.00123456,
        costSource: 'table',
        modelReason: 'primary',
      },
    });

    createdAnswerIds.push(answerId);

    const rows = await db
      .selectFrom('cost_ledger')
      .innerJoin('answers', 'answers.query_id', 'cost_ledger.query_id')
      .selectAll('cost_ledger')
      .where('answers.id', '=', answerId)
      .execute();

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('expected a cost_ledger row');

    expect(row.provider).toBe('openai');
    expect(row.model).toBe('gpt-4.1-mini');
    expect(row.prompt_tokens).toBe(100);
    expect(row.completion_tokens).toBe(50);
    expect(row.cached_tokens).toBe(10);
    expect(row.cost_source).toBe('table');
    expect(row.model_reason).toBe('primary');
    // usd_cost comes back as the numeric column's string wire form; parsing
    // it is what proves the value round-trips rather than merely existing.
    expect(Number(row.usd_cost)).toBeCloseTo(0.00123456, 8);
  });

  it('writes no cost_ledger row for a refusal', async () => {
    const answerId = await repository.record({
      question: 'a refusal carries no cost to record',
      answer: null,
      grounded: false,
      model: null,
      provider: null,
      finishReason: null,
      citations: [],
    });

    createdAnswerIds.push(answerId);

    const rows = await db
      .selectFrom('cost_ledger')
      .innerJoin('answers', 'answers.query_id', 'cost_ledger.query_id')
      .selectAll('cost_ledger')
      .where('answers.id', '=', answerId)
      .execute();

    expect(rows).toEqual([]);
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

  it('writes query, answer and cost in one transaction', async () => {
    // A citation pointing at a chunk that does not exist violates the foreign
    // key, and must leave no orphan query, answer, or ledger row behind.
    //
    // The check is on rows carrying this question, never on a count of the
    // whole table: the e2e runner uses Jest's default parallelism across spec
    // files, so a neighbouring suite committing its own query between the two
    // reads moves a total that this test would then blame on the transaction.
    const question = 'doomed by a citation to a chunk that does not exist';

    // Any row left by an earlier run of this test would itself be the defect
    // under test, so clearing first keeps a single past failure from pinning
    // this red forever. The query row is the join key cost_ledger is
    // normally read back through, but a rolled-back insert never produces
    // one to join against — modelReason doubles as the scoped marker for the
    // ledger side of this same check.
    await db.deleteFrom('queries').where('question', '=', question).execute();
    await db
      .deleteFrom('cost_ledger')
      .where('model_reason', '=', question)
      .execute();

    await expect(
      repository.record({
        question,
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
        cost: {
          provider: 'openai',
          model: 'm',
          promptTokens: 1,
          completionTokens: 1,
          cachedTokens: 0,
          usdCost: 0.01,
          costSource: 'table',
          modelReason: question,
        },
      }),
    ).rejects.toThrow();

    const orphanQueries = await db
      .selectFrom('queries')
      .select('id')
      .where('question', '=', question)
      .execute();

    expect(orphanQueries).toEqual([]);

    const orphanCosts = await db
      .selectFrom('cost_ledger')
      .select('id')
      .where('model_reason', '=', question)
      .execute();

    expect(orphanCosts).toEqual([]);
  });

  it('rolls back the query and answer when the ledger insert itself fails', async () => {
    // The citation-FK test above fails upstream of the ledger insert, so it
    // cannot tell atomicity apart from insert order — a ledger write moved
    // after the transaction commits would still pass it. usd_cost is
    // numeric(14,8): 6 integer digits at most, so a value with more raises
    // "numeric field overflow" from inside the ledger insert statement
    // itself, proving the query and answer it was written alongside are
    // gone because the transaction rolled back, not because some earlier
    // step never ran.
    const question = 'ledger insert overflow, not a step that runs before it';

    await db.deleteFrom('queries').where('question', '=', question).execute();
    await db
      .deleteFrom('cost_ledger')
      .where('model_reason', '=', question)
      .execute();

    await expect(
      repository.record({
        question,
        answer: 'x',
        grounded: true,
        model: 'm',
        provider: 'openai',
        finishReason: 'stop',
        citations: [],
        cost: {
          provider: 'openai',
          model: 'm',
          promptTokens: 1,
          completionTokens: 1,
          cachedTokens: 0,
          usdCost: 100_000_000,
          costSource: 'table',
          modelReason: question,
        },
      }),
    ).rejects.toThrow();

    const orphanQueries = await db
      .selectFrom('queries')
      .select('id')
      .where('question', '=', question)
      .execute();

    expect(orphanQueries).toEqual([]);

    const orphanCosts = await db
      .selectFrom('cost_ledger')
      .select('id')
      .where('model_reason', '=', question)
      .execute();

    expect(orphanCosts).toEqual([]);
  });
});
