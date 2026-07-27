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

async function waitForStatus(
  server: Server,
  id: string,
  target: string,
  attempts = 40,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await request(server).get(`/sources/${id}`);
    const body = response.body as Record<string, unknown>;

    if (body.status === target || body.status === 'failed') {
      return body;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`source ${id} never reached ${target}`);
}

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
    await app.init();
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
    await waitForStatus(app.getHttpServer(), sourceId, 'ready');

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

    expect(secondId).toBe(firstId);
    expect(afterSecond.chunk_count).toBe(afterFirst.chunk_count);
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
