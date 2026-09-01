// LOG_FORMAT is forced here, before AppModule is imported, for the same
// reason throttling.e2e-spec.ts forces THROTTLE_*/TRUST_PROXY the same way:
// @Module()'s decorator (transitively, via ConfigModule.forRoot()) runs
// once, at import time, and every subsequent
// Test.createTestingModule({ imports: [AppModule] }) call in this process —
// including this file's own — reuses that first, already-validated config.
// Jest's own default NODE_ENV=test would already resolve LOG_FORMAT to
// 'json' without this, but forcing it explicitly is what makes this suite
// prove the deliberately-configured behaviour rather than an incidental
// default nothing here actually chose.
const ORIGINAL_LOG_FORMAT = process.env.LOG_FORMAT;
process.env.LOG_FORMAT = 'json';

import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import type Redis from 'ioredis';
import type { Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { KYSELY } from '../src/common/database/database.module';
import type { DB } from '../src/common/database/schema';
import { REQUEST_ID_HEADER } from '../src/common/logging/request-id.middleware';
import { REDIS } from '../src/common/redis/redis.module';
import { listenOnEphemeralPort } from './support/listening-app';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Proves the two lines that attach structured logging to the *real*
 * application, against the *real* `AppModule` — not a throwaway module
 * declaring its own `forRoutes('*')`/`useLogger`, which proves only that
 * the mechanism works, never that this application actually wires it in.
 * Two independent things can each silently disable the feature while every
 * other suite stays green: `AppModule.configure()` never applying
 * `RequestIdMiddleware`, and `LogFormatBootstrap` never installing
 * `JsonLogger` for `LOG_FORMAT=json`. Both are exercised here, through one
 * real app boot.
 */
describe('structured logging, wired into the real AppModule', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await listenOnEphemeralPort(app);
  });

  afterAll(async () => {
    await app.close();

    if (ORIGINAL_LOG_FORMAT === undefined) {
      delete process.env.LOG_FORMAT;
    } else {
      process.env.LOG_FORMAT = ORIGINAL_LOG_FORMAT;
    }
  });

  it('echoes a generated x-request-id on a real response — proves AppModule.configure() actually applies the middleware', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    const requestId = response.headers[REQUEST_ID_HEADER];
    expect(requestId).toMatch(UUID_PATTERN);
  });

  it('a log line emitted after boot is real JSON — proves LOG_FORMAT=json actually installs JsonLogger on this app', () => {
    const written: string[] = [];
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(chunk.toString());
        return true;
      });

    try {
      // LogFormatBootstrap's onApplicationBootstrap already ran as part of
      // listenOnEphemeralPort's app.init() above, so this call — made the
      // same way every other class in this codebase logs, via a fresh
      // `new Logger(...)` — goes through whichever logger that installed.
      new Logger('LoggingE2eProbe').log('logging e2e probe line');
    } finally {
      spy.mockRestore();
    }

    const line = written.find((entry) =>
      entry.includes('logging e2e probe line'),
    );
    expect(line).toBeDefined();

    const parsed = JSON.parse((line ?? '').trim()) as {
      level: string;
      context?: string;
      msg: unknown;
    };
    expect(parsed.level).toBe('log');
    expect(parsed.context).toBe('LoggingE2eProbe');
    expect(parsed.msg).toBe('logging e2e probe line');
  });

  // LogFormatBootstrap used to restore Nest's default logger in its own
  // OnApplicationShutdown — reasoning that Logger.overrideLogger's
  // process-wide static state needed undoing. It didn't just buy nothing
  // (Jest gives each spec file its own module registry, so cross-file
  // pollution was never actually possible): Nest runs shutdown hooks by
  // ascending distance from the root module, so AppModule's own hook
  // (distance 0) fired *before* DatabaseModule's and RedisModule's
  // (distance 1) — flipping the format back to Nest's default before
  // those two modules' own shutdown-hook warnings had a chance to log,
  // which is exactly the moment (a pool or client that will not close
  // during a rolling deploy) a collector parsing the stream as JSON needs
  // them least dropped. This proves the ordering directly, not just the
  // absence of a restore.
  it('Database/Redis shutdown warnings stay JSON even when their own close paths fail', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const shutdownApp = moduleRef.createNestApplication();
    shutdownApp.enableShutdownHooks();
    await listenOnEphemeralPort(shutdownApp);

    const db = shutdownApp.get<Kysely<DB>>(KYSELY);
    const redis = shutdownApp.get<Redis>(REDIS);
    // Forces each module's own shutdown-hook warning path without waiting
    // out its real 3-second timeout — an immediate rejection wins
    // withTimeout's race trivially.
    jest
      .spyOn(db, 'destroy')
      .mockRejectedValue(new Error('forced destroy failure'));
    jest
      .spyOn(redis, 'quit')
      .mockRejectedValue(new Error('forced quit failure'));

    const written: string[] = [];
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(chunk.toString());
        return true;
      });

    try {
      await shutdownApp.close();
    } finally {
      stderrSpy.mockRestore();
      // The spies above replaced destroy()/quit() with an immediate
      // rejection so each warning path fires without the real 3-second
      // wait; the underlying pool/connection was never actually closed by
      // that call, so it is here, for real, to avoid leaking a connection
      // into the rest of this Jest worker's e2e run.
      jest.restoreAllMocks();
      await db.destroy().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    }

    const poolLine = written.find((line) =>
      line.includes('pool did not close'),
    );
    const clientLine = written.find((line) =>
      line.includes('client did not close'),
    );

    expect(poolLine).toBeDefined();
    expect(clientLine).toBeDefined();
    expect(() => {
      JSON.parse(poolLine ?? '');
    }).not.toThrow();
    expect(() => {
      JSON.parse(clientLine ?? '');
    }).not.toThrow();
  });
});
