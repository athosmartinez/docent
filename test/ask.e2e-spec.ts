import { Test } from '@nestjs/testing';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Readable } from 'node:stream';

import { AppModule } from '../src/app.module';
import { CorpusVersion } from '../src/common/cache/corpus-version';
import { KYSELY } from '../src/common/database/database.module';
import { CHUNK_EMBEDDING_DIMENSIONS } from '../src/common/database/schema';
import type { DB } from '../src/common/database/schema';
import {
  EMBEDDINGS,
  type EmbeddingsProvider,
} from '../src/embeddings/embeddings.types';
import { IngestionRepository } from '../src/ingestion/ingestion.repository';
import {
  LLM,
  type CompletionRequest,
  type LlmProvider,
  type LlmStream,
} from '../src/llm/llm.types';
import type { AskResult } from '../src/ask/ask.types';
import { listenOnEphemeralPort } from './support/listening-app';

/**
 * The vector this suite's fixture chunk carries, and the vector its stub
 * returns for every question. Question and fixture therefore sit at cosine
 * distance 0, so nothing another suite owns can outrank the fixture, whatever
 * happens to be in the shared database at the time.
 *
 * A stub deriving the vector from the text's length would not do: that is the
 * identical formula `ingestion.e2e-spec.ts` uses for the corpus it ingests and
 * deletes throughout its own run, which put that suite's chunks at the top of
 * this one's results.
 */
const FIXTURE_VECTOR = Array.from(
  { length: CHUNK_EMBEDDING_DIMENSIONS },
  (_v, i) => i / 10000,
);

const stubEmbeddings: EmbeddingsProvider = {
  embed: (texts) => Promise.resolve(texts.map(() => [...FIXTURE_VECTOR])),
};

// Wraps a plain async-iterable of token deltas as the LlmStream shape the
// provider interface requires. A stub can supply the finish reason up
// front; the real provider instead reads it off the stream's last chunk.
function llmStream(
  tokens: AsyncIterable<string>,
  finishReason: string | null = 'stop',
): LlmStream {
  const iterator = tokens[Symbol.asyncIterator]();

  return {
    [Symbol.asyncIterator]: () => iterator,
    outcome: () => ({
      model: 'stub-model',
      provider: 'stub',
      finishReason,
      usage: null,
      reportedCostUsd: null,
      modelReason: 'primary',
    }),
  };
}

const stubLlm: LlmProvider = {
  complete: () =>
    Promise.resolve({
      text: 'Use the marker option [1].',
      model: 'stub-model',
      provider: 'stub',
      finishReason: 'stop',
      usage: null,
      reportedCostUsd: null,
      modelReason: 'primary',
    }),
  // A Readable is an AsyncIterable<string> — for await consumes it exactly
  // like a generator — without an async function that has no await in it.
  stream: () => llmStream(Readable.from(['Use the ', 'marker option [1].'])),
};

/**
 * The overrides every module in this file needs. `RETRIEVAL_TOP_K` is pinned
 * to 1 so an answer cites only the chunk this suite owns.
 *
 * The database is shared: other suites ingest and delete `ready` sources while
 * this one answers, and a citation pointing at a chunk deleted between
 * retrieval and the insert violates the foreign key. That aborts the whole
 * `record` transaction, which `persist` swallows by design — so the row simply
 * never appears, and the assertion fails as though persistence were broken.
 * Citing only what this suite owns closes the window instead of narrowing it.
 *
 * Numbering several citations 1..n is a unit-test concern and stays covered in
 * `src/ask/prompt.spec.ts`; nothing is lost by asking for one here.
 */
function askTestingModule(): TestingModuleBuilder {
  return Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMBEDDINGS)
    .useValue(stubEmbeddings)
    .overrideProvider('RETRIEVAL_TOP_K')
    .useValue(1);
}

/**
 * A stand-in for `CorpusVersion`, scoped to nothing but this test's own
 * in-memory state. The real class derives from `sources` — a table several
 * other e2e suites insert into, delete from and flip the status of while
 * this suite runs — so two HTTP requests moments apart in the same test can
 * observe two different corpora for a reason that has nothing to do with
 * what the test is trying to prove: whether the *same* question, asked
 * twice, lands on the *same* cache key. `CorpusVersion`'s own derivation
 * from Postgres — that it changes exactly when a `ready` source is added,
 * removed or touched — is proven on its own, isolated from that same
 * contention, in `corpus-version.e2e-spec.ts`. What these tests need from it
 * is only that `AskService` asks it fresh on every call rather than holding
 * a stale value, which a version this suite controls directly demonstrates
 * without depending on anything another suite touches.
 */
// `implements Pick<CorpusVersion, 'current'>` is the point, not decoration:
// `overrideProvider(...).useValue(...)` takes `any`, so nothing else would
// notice `current()`'s signature drifting from the real class — this fake
// would keep compiling and these tests would keep passing against a shape
// CorpusVersion no longer has.
class FakeCorpusVersion implements Pick<CorpusVersion, 'current'> {
  private version = `fake-corpus-version-${randomUUID()}`;

  current(): Promise<string> {
    return Promise.resolve(this.version);
  }

  /** Simulates what a real corpus change does to `CorpusVersion.current()`. */
  bump(): void {
    this.version = `fake-corpus-version-${randomUUID()}`;
  }
}

describe('ask', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;
  let sourceId: string;
  let markerChunkId: string;

  beforeAll(async () => {
    const moduleRef = await askTestingModule()
      .overrideProvider(LLM)
      .useValue(stubLlm)
      .compile();

    app = moduleRef.createNestApplication();
    await listenOnEphemeralPort(app);

    db = app.get<Kysely<DB>>(KYSELY);

    const source = await db
      .insertInto('sources')
      .values({ uri: 'ask-e2e-fixture', type: 'docs', status: 'ready' })
      .returning('id')
      .executeTakeFirstOrThrow();
    sourceId = source.id;

    const document = await db
      .insertInto('documents')
      .values({ source_id: sourceId, path: 'marker.md', title: 'Marker' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const chunk = await sql<{ id: string }>`
      INSERT INTO chunks (document_id, ordinal, content, heading_path, token_count, embedding)
      VALUES (${document.id}, 0,
              'The unmistakablemarker option enables strict validation.',
              ARRAY['Marker'], 8,
              ${`[${FIXTURE_VECTOR.join(',')}]`}::vector)
      RETURNING id
    `.execute(db);
    markerChunkId = chunk.rows[0]!.id;
  });

  afterAll(async () => {
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    // Scoped to the questions this suite asks. An unqualified
    // `deleteFrom('queries')` would cascade through answers and citations and
    // wipe every other suite's rows — and the e2e runner uses Jest's default
    // parallelism across spec files, so a neighbouring suite's fixtures would
    // vanish mid-run and fail as though the code under test were broken.
    await db
      .deleteFrom('queries')
      .where('question', 'like', '%unmistakablemarker%')
      .execute();
    await app.close();
  });

  it('rejects an empty question', async () => {
    await request(app.getHttpServer())
      .post('/ask')
      .send({ question: '' })
      .expect(400);
  });

  it('rejects a missing question', async () => {
    await request(app.getHttpServer()).post('/ask').send({}).expect(400);
  });

  it('answers a question the corpus covers, with citations', async () => {
    const response = await request(app.getHttpServer())
      .post('/ask')
      .send({ question: 'what does unmistakablemarker do?' })
      .expect(200);
    const body = response.body as AskResult;

    expect(body.grounded).toBe(true);
    expect(body.answer).toContain('[1]');
    expect(body.citations[0]?.path).toBe('marker.md');
    expect(body.citations[0]?.ordinal).toBe(1);
  });

  it('persists the question and its citations', async () => {
    // Distinct question text, so the filter below can require an exact
    // match on this test's own row instead of "some citation row exists
    // somewhere" — an unscoped read would pass on any leftover citation from
    // a crashed run, a concurrently-running suite (ask.repository.e2e-spec.ts
    // also inserts citations), or a manual run against the same database.
    // "the" is the only other word: this corpus is a real, ingested
    // documentation set alongside the fixture, and any other real word here
    // would compete against "unmistakablemarker" for ranking the way it does
    // not need to in the question the earlier test asks.
    const question = 'what does the unmistakablemarker do?';

    await request(app.getHttpServer())
      .post('/ask')
      .send({ question })
      .expect(200);

    const rows = await db
      .selectFrom('citations')
      .innerJoin('answers', 'answers.id', 'citations.answer_id')
      .innerJoin('queries', 'queries.id', 'answers.query_id')
      .select(['citations.ordinal', 'citations.chunk_id'])
      .where('queries.question', '=', question)
      .orderBy('citations.ordinal')
      .execute();

    // Exactly the fixture chunk, and nothing else: the suite asks for one
    // citation and owns the chunk that wins it. Asserting the length as well
    // as the row is what makes a citation leaking in from another suite's
    // fixtures a failure here rather than a silent passenger.
    expect(rows).toEqual([{ ordinal: 1, chunk_id: markerChunkId }]);
  });

  it('streams citations before the first token', async () => {
    // A question distinct from every other in this file: this test wants a
    // genuine live stream (multiple deltas from stubLlm.stream, not the
    // single cached frame a hit would produce), which only a guaranteed
    // cache miss can demonstrate — the shape of a cache hit's SSE response
    // is covered separately, on purpose, below.
    const question = `what does unmistakablemarker do, live stream ${randomUUID()}?`;

    const response = await request(app.getHttpServer())
      .post('/ask/stream')
      .send({ question })
      .expect(200)
      .expect('content-type', /text\/event-stream/);

    const citationsAt = response.text.indexOf('event: citations');
    const tokenAt = response.text.indexOf('event: token');

    expect(citationsAt).toBeGreaterThanOrEqual(0);
    expect(tokenAt).toBeGreaterThan(citationsAt);
    expect(response.text).toContain('event: done');
  });

  it('refuses over SSE without calling the model, when nothing is within the distance threshold', async () => {
    let streamCalls = 0;
    const countingLlm: LlmProvider = {
      complete: (request: CompletionRequest) => stubLlm.complete(request),
      stream: (request: CompletionRequest) => {
        streamCalls += 1;
        return stubLlm.stream(request);
      },
    };

    // No finite distance can ever clear a threshold of negative infinity, so
    // retrieval reports ungrounded regardless of what the corpus contains.
    const ungrounded = await askTestingModule()
      .overrideProvider(LLM)
      .useValue(countingLlm)
      .overrideProvider('GROUNDING_MAX_DISTANCE')
      .useValue(Number.NEGATIVE_INFINITY)
      .compile();

    const ungroundedApp =
      ungrounded.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(ungroundedApp);

    // A question no earlier test in this file has asked: the answer cache is
    // keyed only on the question and the corpus version, not on this app's
    // one-off GROUNDING_MAX_DISTANCE override, so reusing a question another
    // test already got a grounded answer for would serve that cached answer
    // here regardless of the override — never reaching retrieval at all.
    const question = `what does unmistakablemarker do, sse refusal ${randomUUID()}?`;

    try {
      const response = await request(ungroundedApp.getHttpServer())
        .post('/ask/stream')
        .send({ question })
        .expect(200)
        .expect('content-type', /text\/event-stream/);

      expect(response.text).toBe(
        'event: citations\ndata: []\n\nevent: done\ndata: {"grounded":false}\n\n',
      );
      expect(response.text).not.toContain('event: token');
      expect(streamCalls).toBe(0);
    } finally {
      await ungroundedApp.close();
    }
  });

  it('reports a mid-stream failure as an SSE event, not a status code', async () => {
    // Throws after its first yield, so the failure lands after citations and
    // at least one token have already gone out on the wire — the case where
    // a status code is no longer possible because the response line and
    // headers are already sent.
    function* explodingTokens(): Generator<string> {
      yield 'Use the ';
      throw new Error('stream exploded mid-flight');
    }

    const failing = await askTestingModule()
      .overrideProvider(LLM)
      .useValue({
        complete: (request: CompletionRequest) => stubLlm.complete(request),
        stream: () => llmStream(Readable.from(explodingTokens())),
      })
      .compile();

    const failingApp =
      failing.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(failingApp);

    // Distinct from every other question in this file, for the same reason
    // as the SSE-refusal test above: a cache hit would short-circuit before
    // this app's exploding stream override is ever reached.
    const question = `what does unmistakablemarker do, mid-stream failure ${randomUUID()}?`;

    try {
      const response = await request(failingApp.getHttpServer())
        .post('/ask/stream')
        .send({ question })
        .expect(200)
        .expect('content-type', /text\/event-stream/);

      const citationsAt = response.text.indexOf('event: citations');
      const tokenAt = response.text.indexOf('event: token');
      const errorAt = response.text.indexOf('event: error');

      expect(citationsAt).toBeGreaterThanOrEqual(0);
      expect(tokenAt).toBeGreaterThan(citationsAt);
      expect(errorAt).toBeGreaterThan(tokenAt);
      // The upstream error's own text never reaches the wire — only the
      // fixed, non-specific message does. An unauthenticated public
      // endpoint must not leak internal failure detail to the client.
      expect(response.text).not.toContain('stream exploded mid-flight');
      expect(response.text).toContain('the service is temporarily unavailable');
      expect(response.text).not.toContain('event: done');
    } finally {
      await failingApp.close();
    }
  });

  it('serves the chat page at the root', async () => {
    await request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('content-type', /text\/html/);
  });

  it('answers 503, not 500, when the provider fails', async () => {
    // A failing upstream is unavailability, not a bug in this service, and a
    // client deciding whether to retry reads the class of the status code.
    const failing = await askTestingModule()
      .overrideProvider(LLM)
      .useValue({
        complete: () => Promise.reject(new Error('upstream is down')),
        // Calling through rather than passing the method reference directly
        // avoids detaching it from `stubLlm`.
        stream: (request: CompletionRequest) => stubLlm.stream(request),
      })
      .compile();

    const failingApp =
      failing.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(failingApp);

    // Distinct from every other question in this file, for the same reason
    // as the two SSE tests above: a cache hit would short-circuit before
    // this app's rejecting `complete()` override is ever reached.
    const question = `what does unmistakablemarker do, 503 on failure ${randomUUID()}?`;

    try {
      const response = await request(failingApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(503);

      // The upstream error's own text (which could carry an internal host
      // or port) never reaches the client — only the fixed, non-specific
      // message does.
      const body = response.body as { message?: unknown };
      expect(body.message).not.toContain('upstream is down');
      expect(body.message).toBe(
        'the service is temporarily unavailable, try again shortly',
      );
    } finally {
      await failingApp.close();
    }
  });

  it('persists an answer that was streamed, with its citations', async () => {
    // Distinct from every other question this file sends over /ask/stream or
    // /ask — capitalised, otherwise identical. Several earlier tests already
    // reuse 'what does unmistakablemarker do?' verbatim (one of them over the
    // JSON endpoint, which has always recorded), so filtering by substring
    // would let this test pass on a row a different endpoint wrote, whether
    // or not the streaming path records anything at all. Case changes neither
    // the tsvector lexemes nor the stub embedding, which ignores its input, so
    // this ranks identically to the phrasings above.
    const question = 'What does unmistakablemarker do?';

    await request(app.getHttpServer())
      .post('/ask/stream')
      .send({ question })
      .expect(200);

    const rows = await db
      .selectFrom('citations')
      .innerJoin('answers', 'answers.id', 'citations.answer_id')
      .innerJoin('queries', 'queries.id', 'answers.query_id')
      .select(['citations.ordinal', 'answers.answer', 'answers.grounded'])
      .where('queries.question', '=', question)
      .orderBy('citations.ordinal')
      .execute();

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.ordinal).toBe(1);
    expect(rows[0]?.grounded).toBe(true);
    expect(rows[0]?.answer).toContain('marker option');
  });

  it('persists the finish reason a stream actually reports, not a fabricated one', async () => {
    // Distinct question text so this row is never confused with the 'stop'
    // row the previous test writes.
    const question = 'What exactly does unmistakablemarker do?';

    const truncated = await askTestingModule()
      .overrideProvider(LLM)
      .useValue({
        complete: (request: CompletionRequest) => stubLlm.complete(request),
        stream: () =>
          llmStream(
            Readable.from(['Use the ', 'marker option [1].']),
            'length',
          ),
      })
      .compile();

    const truncatedApp =
      truncated.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(truncatedApp);

    try {
      await request(truncatedApp.getHttpServer())
        .post('/ask/stream')
        .send({ question })
        .expect(200);

      const rows = await db
        .selectFrom('answers')
        .innerJoin('queries', 'queries.id', 'answers.query_id')
        .select(['answers.finish_reason'])
        .where('queries.question', '=', question)
        .execute();

      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.finish_reason).toBe('length');
      expect(rows[0]?.finish_reason).not.toBe('stop');
    } finally {
      await truncatedApp.close();
    }
  });

  it('persists a refusal that was streamed, with no citations', async () => {
    // Distinct from every question above — same stopwords-plus-lexeme shape
    // ('what', 'is', 'for' are all Postgres default-English stopwords, same
    // as 'does'/'do'/'the' in the other phrasings — so this dilutes ranking
    // no differently than the others, which is moot here regardless, since
    // the threshold override below forces a refusal independent of score.
    const question = 'What is unmistakablemarker for?';

    // Forces the refusal the same way the existing SSE-refusal test does:
    // by overriding the GROUNDING_MAX_DISTANCE provider token to a value no
    // finite distance can clear, not by picking a question that happens to
    // score badly — which would break the moment the corpus or the floor
    // moved.
    const ungrounded = await askTestingModule()
      .overrideProvider(LLM)
      .useValue(stubLlm)
      .overrideProvider('GROUNDING_MAX_DISTANCE')
      .useValue(Number.NEGATIVE_INFINITY)
      .compile();

    const ungroundedApp =
      ungrounded.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(ungroundedApp);

    try {
      await request(ungroundedApp.getHttpServer())
        .post('/ask/stream')
        .send({ question })
        .expect(200);

      const rows = await db
        .selectFrom('answers')
        .innerJoin('queries', 'queries.id', 'answers.query_id')
        .select(['answers.id', 'answers.answer', 'answers.grounded'])
        .where('queries.question', '=', question)
        .execute();

      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.grounded).toBe(false);
      expect(rows[0]?.answer).toBeNull();

      // Scoped to exactly the answer row(s) this test created, not a bare
      // count of the whole table — an unscoped read would stay green even if
      // some other suite's citations happened to exist.
      const citations = await db
        .selectFrom('citations')
        .selectAll()
        .where(
          'answer_id',
          'in',
          rows.map((row) => row.id),
        )
        .execute();

      expect(citations).toHaveLength(0);
    } finally {
      await ungroundedApp.close();
    }
  });

  it('serves a repeated question from cache, calling the model only once, and records the second hit as cached with zero cost', async () => {
    let completeCalls = 0;
    const countingLlm: LlmProvider = {
      complete: (request: CompletionRequest) => {
        completeCalls += 1;
        return stubLlm.complete(request);
      },
      stream: (request: CompletionRequest) => stubLlm.stream(request),
    };

    const counting = await askTestingModule()
      .overrideProvider(LLM)
      .useValue(countingLlm)
      .overrideProvider(CorpusVersion)
      .useValue(new FakeCorpusVersion())
      .compile();

    const countingApp =
      counting.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(countingApp);

    // A random suffix per run: Redis persists across runs of this suite (the
    // answer cache is not flushed between them), so a fixed question text
    // would already be a hit on a second run and never exercise the "first
    // request is a genuine miss" half of this test.
    const question = `what does unmistakablemarker do, cache test ${randomUUID()}?`;

    try {
      const first = await request(countingApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);
      const second = await request(countingApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);

      expect(completeCalls).toBe(1);
      expect(second.body).toEqual(first.body);

      const rows = await db
        .selectFrom('cost_ledger')
        .innerJoin('queries', 'queries.id', 'cost_ledger.query_id')
        .select(['cost_ledger.cost_source', 'cost_ledger.usd_cost'])
        .where('queries.question', '=', question)
        .orderBy('cost_ledger.created_at')
        .execute();

      expect(rows).toHaveLength(2);
      expect(rows[0]?.cost_source).not.toBe('cached');
      expect(rows[1]?.cost_source).toBe('cached');
      expect(Number(rows[1]?.usd_cost)).toBe(0);
    } finally {
      await countingApp.close();
    }
  });

  it('invalidates the cache when the corpus changes, so the next identical question misses again', async () => {
    let completeCalls = 0;
    const countingLlm: LlmProvider = {
      complete: (request: CompletionRequest) => {
        completeCalls += 1;
        return stubLlm.complete(request);
      },
      stream: (request: CompletionRequest) => stubLlm.stream(request),
    };

    // Owned directly (rather than reached through the app's DI container)
    // so this test can bump it deliberately between calls, the same way a
    // real ready-source insert changes what the real CorpusVersion.current()
    // returns — that a real insert actually does so is proven on its own,
    // isolated from other suites' concurrent writes to `sources`, in
    // corpus-version.e2e-spec.ts. What this test proves is the other half:
    // that AskService asks for the version fresh on every request instead of
    // holding the value from an earlier one, which a version this test
    // controls demonstrates deterministically, without depending on the
    // timing of a write to a table several other suites are also writing to.
    const fakeCorpusVersion = new FakeCorpusVersion();

    const counting = await askTestingModule()
      .overrideProvider(LLM)
      .useValue(countingLlm)
      .overrideProvider(CorpusVersion)
      .useValue(fakeCorpusVersion)
      .compile();

    const countingApp =
      counting.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(countingApp);

    const question = `what does unmistakablemarker do, invalidation test ${randomUUID()}?`;

    try {
      await request(countingApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);
      expect(completeCalls).toBe(1);

      // Repeats cleanly from cache while the corpus hasn't changed.
      await request(countingApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);
      expect(completeCalls).toBe(1);

      fakeCorpusVersion.bump();

      await request(countingApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);
      expect(completeCalls).toBe(2);
    } finally {
      await countingApp.close();
    }
  });

  // The test above proves AskService's wiring — that it asks for the
  // version fresh on every request — against a version it controls
  // directly. corpus-version.e2e-spec.ts proves, in isolation, that a real
  // Postgres write actually moves CorpusVersion.current(). Neither proves
  // the two are connected: that a real ingestion write, through the real
  // repository methods a pipeline actually calls, changes the real
  // CorpusVersion.current(), and that AskService reading the real one then
  // misses. This test is the missing link — no CorpusVersion override, a
  // real IngestionRepository.createSource()+markReady() call standing in
  // for what a completed ingestion run does.
  //
  // Safe under the shared database because it asserts only change ⇒ miss:
  // a sibling suite committing its own `ready` row in the gap can only also
  // change the version, which reinforces the expected second miss — it can
  // produce a spurious pass, never a spurious failure. The complementary
  // direction (stability ⇒ hit) is already covered by the fake-based tests
  // above, which is what makes asserting only one direction here sufficient
  // rather than a gap of its own.
  it('a real ingestion write invalidates the cache through the real CorpusVersion, not a double standing in for it', async () => {
    let completeCalls = 0;
    const countingLlm: LlmProvider = {
      complete: (request: CompletionRequest) => {
        completeCalls += 1;
        return stubLlm.complete(request);
      },
      stream: (request: CompletionRequest) => stubLlm.stream(request),
    };

    // No CorpusVersion override: this app's cache reads and writes go
    // through the real class, querying the real `sources` table.
    const counting = await askTestingModule()
      .overrideProvider(LLM)
      .useValue(countingLlm)
      .compile();

    const countingApp =
      counting.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(countingApp);

    const ingestionRepository = countingApp.get(IngestionRepository);
    const question = `what does unmistakablemarker do, real chain test ${randomUUID()}?`;
    // Unique to this test, so its own cleanup below can never touch a row
    // another suite created.
    const uri = `ask-e2e-real-chain-${randomUUID()}`;
    let sourceId: string | undefined;

    try {
      await request(countingApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);
      expect(completeCalls).toBe(1);

      // The real write path a completed ingestion run takes: create the row,
      // then mark it ready — the same two repository calls IngestionService
      // itself makes, not a raw insert standing in for them.
      sourceId = await ingestionRepository.createSource(uri, 'docs');
      await ingestionRepository.markReady(sourceId);

      await request(countingApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);
      expect(completeCalls).toBe(2);
    } finally {
      if (sourceId) {
        await db.deleteFrom('sources').where('id', '=', sourceId).execute();
      }
      await countingApp.close();
    }
  });

  it('a question cached via /ask is also served from cache via /ask/stream, and vice versa', async () => {
    let completeCalls = 0;
    let streamCalls = 0;
    const countingLlm: LlmProvider = {
      complete: (request: CompletionRequest) => {
        completeCalls += 1;
        return stubLlm.complete(request);
      },
      stream: (request: CompletionRequest) => {
        streamCalls += 1;
        return stubLlm.stream(request);
      },
    };

    const twins = await askTestingModule()
      .overrideProvider(LLM)
      .useValue(countingLlm)
      .overrideProvider(CorpusVersion)
      .useValue(new FakeCorpusVersion())
      .compile();

    const twinsApp = twins.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(twinsApp);

    const question = `what does unmistakablemarker do, twin cache test ${randomUUID()}?`;

    try {
      // Populated via the JSON endpoint...
      await request(twinsApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);
      expect(completeCalls).toBe(1);

      // ...served from cache via the streaming endpoint, without a fresh
      // stream call — the two endpoints share one cache, keyed on the same
      // normalised question and corpus version, so a hit on one path is a
      // hit on the other.
      const streamed = await request(twinsApp.getHttpServer())
        .post('/ask/stream')
        .send({ question })
        .expect(200);

      expect(streamCalls).toBe(0);
      expect(streamed.text).toContain('event: token');
      expect(streamed.text).toContain('Use the marker option [1].');
    } finally {
      await twinsApp.close();
    }
  });

  it('serves a cache hit over SSE as citations, one token event carrying the whole text, then done', async () => {
    // Its own app rather than the file's shared one: the shared app's
    // CorpusVersion is the real, Postgres-derived one, which two HTTP calls
    // apart in time would race every other suite writing to `sources` (see
    // FakeCorpusVersion above) — this test cares about SSE frame shape, not
    // about corpus derivation, so it does not need the real one.
    const shape = await askTestingModule()
      .overrideProvider(LLM)
      .useValue(stubLlm)
      .overrideProvider(CorpusVersion)
      .useValue(new FakeCorpusVersion())
      .compile();

    const shapeApp = shape.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(shapeApp);

    const question = `what does unmistakablemarker do, sse hit shape test ${randomUUID()}?`;

    try {
      // Warms the cache via the JSON endpoint.
      await request(shapeApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);

      const response = await request(shapeApp.getHttpServer())
        .post('/ask/stream')
        .send({ question })
        .expect(200)
        .expect('content-type', /text\/event-stream/);

      const citationsAt = response.text.indexOf('event: citations');
      const tokenAt = response.text.indexOf('event: token');
      const doneAt = response.text.indexOf('event: done');

      expect(citationsAt).toBeGreaterThanOrEqual(0);
      expect(tokenAt).toBeGreaterThan(citationsAt);
      expect(doneAt).toBeGreaterThan(tokenAt);

      // Exactly one token event: the whole answer arrives in a single frame,
      // not paced out delta by delta the way a fresh completion would be.
      expect(response.text.match(/event: token/g)).toHaveLength(1);
      expect(response.text).toContain('data: "Use the marker option [1]."');
    } finally {
      await shapeApp.close();
    }
  });

  // The SSE hit branch sends its own `citations`/`token`/`done` frames
  // directly, rather than going through the same code AskService.ask() uses
  // to answer a JSON request — so nothing stops a future edit from wiring up
  // the frames correctly while forgetting the recordCacheHit() call beside
  // them. Every other test proving the frame shape stops at the wire and
  // never checks the database, so a regression here (dropping the record
  // call while keeping the frames byte-for-byte identical) would pass three
  // full test runs unnoticed: the eval suite reads `queries`, and a hit
  // served over this endpoint would vanish from it silently.
  it('records a cache hit served over SSE, so it does not vanish from queries, answers or cost_ledger', async () => {
    const recording = await askTestingModule()
      .overrideProvider(LLM)
      .useValue(stubLlm)
      .overrideProvider(CorpusVersion)
      .useValue(new FakeCorpusVersion())
      .compile();

    const recordingApp =
      recording.createNestApplication<INestApplication<Server>>();
    await listenOnEphemeralPort(recordingApp);

    const question = `what does unmistakablemarker do, sse hit recording test ${randomUUID()}?`;

    try {
      // Warms the cache via the JSON endpoint — one queries/answers row.
      await request(recordingApp.getHttpServer())
        .post('/ask')
        .send({ question })
        .expect(200);

      // Served from cache over SSE — should be a second queries/answers row,
      // with a `cached` cost_ledger row alongside it.
      await request(recordingApp.getHttpServer())
        .post('/ask/stream')
        .send({ question })
        .expect(200)
        .expect('content-type', /text\/event-stream/);

      const queries = await db
        .selectFrom('queries')
        .select('id')
        .where('question', '=', question)
        .execute();
      expect(queries).toHaveLength(2);

      const costRows = await db
        .selectFrom('cost_ledger')
        .innerJoin('queries', 'queries.id', 'cost_ledger.query_id')
        .select(['cost_ledger.cost_source', 'cost_ledger.usd_cost'])
        .where('queries.question', '=', question)
        .orderBy('cost_ledger.created_at')
        .execute();

      expect(costRows).toHaveLength(2);
      expect(costRows[1]?.cost_source).toBe('cached');
      expect(Number(costRows[1]?.usd_cost)).toBe(0);
    } finally {
      await recordingApp.close();
    }
  });
});
