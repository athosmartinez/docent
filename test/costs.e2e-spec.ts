import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { KYSELY } from '../src/common/database/database.module';
import type { DB } from '../src/common/database/schema';
import type { CostsResponse } from '../src/cost/cost.controller';
import { listenOnEphemeralPort } from './support/listening-app';

/**
 * Every real insertion path (AskRepository.record) lets created_at default
 * to the database's own now(), so no other suite or real traffic can ever
 * produce a row timestamped inside a fixed window this far in the past. That
 * makes the window itself the scoping mechanism a date-range endpoint can be
 * tested against — there is no query_id or provider filter on /costs to
 * scope by instead.
 */
const WINDOW_FROM = new Date('2019-06-01T00:00:00.000Z');
const WINDOW_TO = new Date('2019-06-02T00:00:00.000Z');
const BEFORE_WINDOW = new Date('2019-05-31T23:00:00.000Z');

const QUESTION_MARKER = 'costs e2e fixture';

const PROVIDER_A = 'costs-e2e-provider-a';
const MODEL_A = 'costs-e2e-model-a';
const PROVIDER_B = 'costs-e2e-provider-b';
const MODEL_B = 'costs-e2e-model-b';

interface FixtureInput {
  createdAt: Date;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  usdCost: number | null;
  costSource: string;
}

describe('GET /costs', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;
  // Every queries row this suite inserts, tracked so cleanup can delete
  // exactly these and nothing another suite owns. cost_ledger cascades from
  // queries (ON DELETE CASCADE), so deleting here is enough for both tables.
  const queryIds: string[] = [];

  async function insertFixture(input: FixtureInput): Promise<void> {
    const query = await db
      .insertInto('queries')
      .values({ question: `${QUESTION_MARKER} ${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();

    queryIds.push(query.id);

    await db
      .insertInto('cost_ledger')
      .values({
        query_id: query.id,
        provider: input.provider,
        model: input.model,
        prompt_tokens: input.promptTokens,
        completion_tokens: input.completionTokens,
        cached_tokens: input.cachedTokens,
        usd_cost: input.usdCost,
        cost_source: input.costSource,
        model_reason: QUESTION_MARKER,
        created_at: input.createdAt,
      })
      .execute();
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await listenOnEphemeralPort(app);

    db = app.get<Kysely<DB>>(KYSELY);

    // A previous failed run of this same suite would leave rows inside this
    // exact window, tagged with this exact marker — clearing them first
    // keeps one past failure from inflating every total this run computes.
    await db
      .deleteFrom('queries')
      .where('question', 'like', `${QUESTION_MARKER}%`)
      .execute();

    // Two rows for provider A: exercises SUM across more than one row for
    // the same group, not just COUNT.
    await insertFixture({
      createdAt: new Date(WINDOW_FROM.getTime() + 60 * 60 * 1000),
      provider: PROVIDER_A,
      model: MODEL_A,
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 10,
      usdCost: 0.02,
      costSource: 'table',
    });
    await insertFixture({
      createdAt: new Date(WINDOW_FROM.getTime() + 3 * 60 * 60 * 1000),
      provider: PROVIDER_A,
      model: MODEL_A,
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 10,
      usdCost: 0.01,
      costSource: 'table',
    });
    // One unpriced row for provider B: neither the provider nor the local
    // table priced it, so usd_cost is null but the request still counts.
    await insertFixture({
      createdAt: new Date(WINDOW_FROM.getTime() + 2 * 60 * 60 * 1000),
      provider: PROVIDER_B,
      model: MODEL_B,
      promptTokens: 200,
      completionTokens: 80,
      cachedTokens: 0,
      usdCost: null,
      costSource: 'unknown',
    });
    // Outside the window on both sides — must not appear in any total.
    await insertFixture({
      createdAt: BEFORE_WINDOW,
      provider: PROVIDER_A,
      model: MODEL_A,
      promptTokens: 999,
      completionTokens: 999,
      cachedTokens: 999,
      usdCost: 9,
      costSource: 'table',
    });
    await insertFixture({
      createdAt: WINDOW_TO,
      provider: PROVIDER_A,
      model: MODEL_A,
      promptTokens: 999,
      completionTokens: 999,
      cachedTokens: 999,
      usdCost: 9,
      costSource: 'table',
    });
  });

  afterAll(async () => {
    if (queryIds.length > 0) {
      await db.deleteFrom('queries').where('id', 'in', queryIds).execute();
    }
    await app.close();
  });

  it('sums totals and groups by provider+model over an inclusive-from/exclusive-to window', async () => {
    const response = await request(app.getHttpServer())
      .get('/costs')
      .query({ from: WINDOW_FROM.toISOString(), to: WINDOW_TO.toISOString() });

    expect(response.status).toBe(200);
    const body = response.body as CostsResponse;

    expect(body.from).toBe(WINDOW_FROM.toISOString());
    expect(body.to).toBe(WINDOW_TO.toISOString());

    // Three in-window rows: two priced (A) and one unpriced (B). The two
    // out-of-window rows (one before `from`, one exactly at `to`) each carry
    // usd_cost 9 and token counts of 999 — if either leaked in, every
    // assertion below would catch it, not just `requests`.
    expect(body.totals.requests).toBe(3);
    expect(body.totals.promptTokens).toBe(100 + 100 + 200);
    expect(body.totals.completionTokens).toBe(50 + 50 + 80);
    expect(body.totals.cachedTokens).toBe(10 + 10 + 0);
    expect(typeof body.totals.usdCost).toBe('number');
    expect(body.totals.usdCost).toBeCloseTo(0.03, 8);
    // The unpriced row must still count as a request without dragging the
    // money total toward zero — asserted together so a fix for one cannot
    // silently break the other.
    expect(body.totals.unpricedRequests).toBe(1);

    expect(body.byModel).toHaveLength(2);

    const groupA = body.byModel.find(
      (row) => row.provider === PROVIDER_A && row.model === MODEL_A,
    );
    expect(groupA).toBeDefined();
    expect(groupA?.requests).toBe(2);
    expect(typeof groupA?.usdCost).toBe('number');
    expect(groupA?.usdCost).toBeCloseTo(0.03, 8);
    expect(groupA?.unpricedRequests).toBe(0);

    const groupB = body.byModel.find(
      (row) => row.provider === PROVIDER_B && row.model === MODEL_B,
    );
    expect(groupB).toBeDefined();
    expect(groupB?.requests).toBe(1);
    expect(groupB?.usdCost).toBe(0);
    expect(groupB?.unpricedRequests).toBe(1);
  });

  it('includes a row created exactly at from and excludes one created exactly at to', async () => {
    const from = new Date('2019-06-10T00:00:00.000Z');
    const to = new Date('2019-06-10T01:00:00.000Z');
    const provider = 'costs-e2e-boundary-provider';
    const model = 'costs-e2e-boundary-model';

    await insertFixture({
      createdAt: from,
      provider,
      model,
      promptTokens: 1,
      completionTokens: 1,
      cachedTokens: 0,
      usdCost: 0.001,
      costSource: 'table',
    });
    await insertFixture({
      createdAt: to,
      provider,
      model,
      promptTokens: 1,
      completionTokens: 1,
      cachedTokens: 0,
      usdCost: 0.001,
      costSource: 'table',
    });

    const response = await request(app.getHttpServer())
      .get('/costs')
      .query({ from: from.toISOString(), to: to.toISOString() });

    const body = response.body as CostsResponse;
    const group = body.byModel.find(
      (row) => row.provider === provider && row.model === model,
    );

    expect(group?.requests).toBe(1);
  });

  it('rejects a query value that does not parse as a date', async () => {
    const response = await request(app.getHttpServer())
      .get('/costs')
      .query({ from: 'not-a-date' });

    expect(response.status).toBe(400);
  });

  it('rejects to before from', async () => {
    const response = await request(app.getHttpServer()).get('/costs').query({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });

    expect(response.status).toBe(400);
  });
});
