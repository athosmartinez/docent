import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';

interface HealthResponseBody {
  status: string;
  info: {
    database: { status: string };
    redis: { status: string };
  };
}

describe('GET /health', () => {
  // Typing the server explicitly propagates through getHttpServer() below,
  // instead of leaving it (and the request(...) argument built from it) as
  // `any`.
  let app: INestApplication<Server>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports both dependencies up', async () => {
    const response = await request(app.getHttpServer()).get('/health');
    const body = response.body as HealthResponseBody;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.info.database.status).toBe('up');
    expect(body.info.redis.status).toBe('up');
  });
});
