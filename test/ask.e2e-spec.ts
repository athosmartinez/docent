import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import request from 'supertest';
import type { Server } from 'node:http';
import { Readable } from 'node:stream';

import { AppModule } from '../src/app.module';
import { KYSELY } from '../src/common/database/database.module';
import { CHUNK_EMBEDDING_DIMENSIONS } from '../src/common/database/schema';
import type { DB } from '../src/common/database/schema';
import {
  EMBEDDINGS,
  type EmbeddingsProvider,
} from '../src/embeddings/embeddings.types';
import {
  LLM,
  type CompletionRequest,
  type LlmProvider,
  type LlmStream,
} from '../src/llm/llm.types';
import type { AskResult } from '../src/ask/ask.types';

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
    finishReason: () => finishReason,
  };
}

const stubLlm: LlmProvider = {
  complete: () =>
    Promise.resolve({
      text: 'Use the marker option [1].',
      model: 'stub-model',
      provider: 'stub',
      finishReason: 'stop',
    }),
  // A Readable is an AsyncIterable<string> — for await consumes it exactly
  // like a generator — without an async function that has no await in it.
  stream: () => llmStream(Readable.from(['Use the ', 'marker option [1].'])),
};

describe('ask', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;
  let sourceId: string;
  let markerChunkId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(stubEmbeddings)
      .overrideProvider(LLM)
      .useValue(stubLlm)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

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

    const vector = Array.from(
      { length: CHUNK_EMBEDDING_DIMENSIONS },
      (_v, i) => i / 10000,
    );

    const chunk = await sql<{ id: string }>`
      INSERT INTO chunks (document_id, ordinal, content, heading_path, token_count, embedding)
      VALUES (${document.id}, 0,
              'The unmistakablemarker option enables strict validation.',
              ARRAY['Marker'], 8,
              ${`[${vector.join(',')}]`}::vector)
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

    // The top-ranked citation is the fixture chunk itself, not merely any
    // row — the real corpus this suite runs alongside contributes lower-
    // ranked citations of its own once the answer is grounded.
    expect(rows[0]).toEqual({ ordinal: 1, chunk_id: markerChunkId });
  });

  it('streams citations before the first token', async () => {
    const response = await request(app.getHttpServer())
      .post('/ask/stream')
      .send({ question: 'what does unmistakablemarker do?' })
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
    const ungrounded = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(stubEmbeddings)
      .overrideProvider(LLM)
      .useValue(countingLlm)
      .overrideProvider('GROUNDING_MAX_DISTANCE')
      .useValue(Number.NEGATIVE_INFINITY)
      .compile();

    const ungroundedApp =
      ungrounded.createNestApplication<INestApplication<Server>>();
    await ungroundedApp.init();

    try {
      const response = await request(ungroundedApp.getHttpServer())
        .post('/ask/stream')
        .send({ question: 'what does unmistakablemarker do?' })
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

    const failing = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(stubEmbeddings)
      .overrideProvider(LLM)
      .useValue({
        complete: (request: CompletionRequest) => stubLlm.complete(request),
        stream: () => llmStream(Readable.from(explodingTokens())),
      })
      .compile();

    const failingApp =
      failing.createNestApplication<INestApplication<Server>>();
    await failingApp.init();

    try {
      const response = await request(failingApp.getHttpServer())
        .post('/ask/stream')
        .send({ question: 'what does unmistakablemarker do?' })
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
    const failing = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(stubEmbeddings)
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
    await failingApp.init();

    try {
      const response = await request(failingApp.getHttpServer())
        .post('/ask')
        .send({ question: 'what does unmistakablemarker do?' })
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
    // or not the streaming path records anything at all. Case does not
    // change tsvector lexemes or the stub embedding (a function of string
    // length only), so this ranks identically to the phrasing already proven
    // not to dilute below the grounding threshold against the real,
    // non-hermetic corpus.
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

    const truncated = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(stubEmbeddings)
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
    await truncatedApp.init();

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
    const ungrounded = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS)
      .useValue(stubEmbeddings)
      .overrideProvider(LLM)
      .useValue(stubLlm)
      .overrideProvider('GROUNDING_MAX_DISTANCE')
      .useValue(Number.NEGATIVE_INFINITY)
      .compile();

    const ungroundedApp =
      ungrounded.createNestApplication<INestApplication<Server>>();
    await ungroundedApp.init();

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
});
