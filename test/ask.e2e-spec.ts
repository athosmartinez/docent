import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import request from 'supertest';
import type { Server } from 'node:http';

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

const stubLlm: LlmProvider = {
  complete: () =>
    Promise.resolve({
      text: 'Use the marker option [1].',
      model: 'stub-model',
      provider: 'stub',
      finishReason: 'stop',
    }),
  // The interface returns AsyncIterable<string>, which only an async
  // generator satisfies structurally — a sync one would not — even though
  // this stub yields fixed tokens with no async work of its own.
  // eslint-disable-next-line @typescript-eslint/require-await
  stream: async function* () {
    yield 'Use the ';
    yield 'marker option [1].';
  },
};

describe('ask', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;
  let sourceId: string;

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

    await sql`
      INSERT INTO chunks (document_id, ordinal, content, heading_path, token_count, embedding)
      VALUES (${document.id}, 0,
              'The unmistakablemarker option enables strict validation.',
              ARRAY['Marker'], 8,
              ${`[${vector.join(',')}]`}::vector)
    `.execute(db);
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
    await request(app.getHttpServer())
      .post('/ask')
      .send({ question: 'what does unmistakablemarker do?' })
      .expect(200);

    const rows = await db
      .selectFrom('citations')
      .innerJoin('answers', 'answers.id', 'citations.answer_id')
      .select(['citations.ordinal'])
      .execute();

    expect(rows.length).toBeGreaterThan(0);
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
      await request(failingApp.getHttpServer())
        .post('/ask')
        .send({ question: 'what does unmistakablemarker do?' })
        .expect(503);
    } finally {
      await failingApp.close();
    }
  });
});
