// Every OTHER e2e suite gets its rate limits raised six orders of
// magnitude by test/support/global-setup.js (a Jest globalSetup, run once
// before any worker is spawned, so its process.env mutation is inherited
// by every worker) — high enough that none of their much-higher-than-any-
// real-client request volume can ever exhaust a bucket, while leaving the
// real ThrottlerGuard and its real Redis-backed storage on the path of
// every request in every suite. This suite exists specifically to prove
// those real, low, production limits, so it overrides the four values
// back down for its own app — and sets TRUST_PROXY too, so the wiring
// applying it (TrustProxyBootstrap, an OnApplicationBootstrap provider —
// see trust-proxy.ts and trust-proxy-bootstrap.provider.ts) is exercised
// the same way a real deployment reaches it, rather than called by hand
// from this file the way it used to be.
//
// This has to run before AppModule is imported, not merely before this
// suite's app is built: @Module()'s decorator (transitively, via
// ConfigModule.forRoot()) runs once, at import time, and every subsequent
// Test.createTestingModule({ imports: [AppModule] }) call in this process —
// including this file's own — reuses that first, already-validated config.
// A later assignment in beforeAll is too late; TypeScript compiles a plain
// statement placed before the first `import` to run before it too, which is
// what makes putting it here work. Restored in afterAll so it cannot leak
// into whichever spec file this Jest worker picks up next.
const ORIGINAL_ENV = {
  THROTTLE_DEFAULT_PER_MINUTE: process.env.THROTTLE_DEFAULT_PER_MINUTE,
  THROTTLE_ASK_PER_MINUTE: process.env.THROTTLE_ASK_PER_MINUTE,
  THROTTLE_INGEST_PER_MINUTE: process.env.THROTTLE_INGEST_PER_MINUTE,
  THROTTLE_HEALTH_PER_MINUTE: process.env.THROTTLE_HEALTH_PER_MINUTE,
  TRUST_PROXY: process.env.TRUST_PROXY,
};
process.env.THROTTLE_DEFAULT_PER_MINUTE = '15';
process.env.THROTTLE_ASK_PER_MINUTE = '8';
process.env.THROTTLE_INGEST_PER_MINUTE = '3';
process.env.THROTTLE_HEALTH_PER_MINUTE = '6';
// A hop count of 1 — trust exactly one reverse proxy directly in front of
// this process — the same form a real single-load-balancer deployment
// would configure (see env.schema.ts's parseTrustProxy: the boolean `true`
// this suite used to pass is rejected at boot precisely because it does
// *not* behave like this). With one entry in X-Forwarded-For, "the entry a
// trusted hop added" and "the only entry present" are the same thing, so
// every scenario below that sets a single address works unchanged; the
// dedicated test further down adds a second, forged entry to prove the
// part unique to a real hop count actually holds.
process.env.TRUST_PROXY = '1';

/**
 * Puts one variable back the way it was found. Assigning an absent value
 * back is not a restore: `process.env` coerces, so `= undefined` writes the
 * five-character string 'undefined', which every consumer then reads as a
 * real setting. `TRUST_PROXY` is the case that bites — nothing exports it and
 * `.env` does not define it, so its captured value is always absent, and
 * `'undefined'` parses as a one-entry address list that Express rejects at
 * `app.set`, throwing on the next app built in the same environment.
 */
function restore(key: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = original;
}

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { randomInt } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import type { Env } from '../src/common/config/env.schema';
import { KYSELY } from '../src/common/database/database.module';
import { CHUNK_EMBEDDING_DIMENSIONS } from '../src/common/database/schema';
import type { DB } from '../src/common/database/schema';
import {
  EMBEDDINGS,
  type EmbeddingsProvider,
} from '../src/embeddings/embeddings.types';
import { listenOnEphemeralPort } from './support/listening-app';

// GROUNDING_MAX_DISTANCE is forced to negative infinity below, so every
// question refuses before any distance is compared — the vector's actual
// values never factor into anything, only its length.
const stubEmbeddings: EmbeddingsProvider = {
  embed: (texts) =>
    Promise.resolve(
      texts.map(() => new Array<number>(CHUNK_EMBEDDING_DIMENSIONS).fill(0)),
    ),
};

const QUESTION = 'what does the throttling e2e sentinel fixture do?';

/**
 * A fresh, plausible client address for one scenario below to stand behind.
 * This suite runs against the real, shared Redis every other e2e suite
 * does — without a private address per scenario, two scenarios in this file
 * (or two separate runs of it) would land on the same counter and throttle
 * each other for a reason that has nothing to do with what either checks.
 * 253^3 combinations makes a collision between any two calls, across ten
 * repeated runs of this file, astronomically unlikely.
 */
function fakeClientAddress(): string {
  const octet = () => randomInt(1, 254);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('rate limiting', () => {
  let app: INestApplication<Server>;
  let server: Server;
  let db: Kysely<DB>;
  let askLimit: number;
  let ingestLimit: number;
  let healthLimit: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMBEDDINGS)
      .useValue(stubEmbeddings)
      .overrideProvider('GROUNDING_MAX_DISTANCE')
      .useValue(Number.NEGATIVE_INFINITY)
      .compile();

    app = moduleRef.createNestApplication();
    // No manual applyTrustProxy(app, ...) call here any more: TRUST_PROXY
    // above is what this suite's app reads, and TrustProxyBootstrap (an
    // OnApplicationBootstrap provider in ThrottlingModule) applies it
    // during app.init() below — the same wiring, run the same way,
    // production and every e2e suite alike.
    await listenOnEphemeralPort(app);
    server = app.getHttpServer();
    db = app.get<Kysely<DB>>(KYSELY);

    // Read rather than hardcoded, so this suite keeps proving the
    // configured limit — whatever it is — rather than one number this file
    // happens to agree with today.
    const config = app.get<ConfigService<Env, true>>(ConfigService);
    askLimit = config.get('THROTTLE_ASK_PER_MINUTE', { infer: true });
    ingestLimit = config.get('THROTTLE_INGEST_PER_MINUTE', { infer: true });
    healthLimit = config.get('THROTTLE_HEALTH_PER_MINUTE', { infer: true });
  });

  afterAll(async () => {
    for (const [key, original] of Object.entries(ORIGINAL_ENV)) {
      restore(key, original);
    }
    // Every request below reduces to the same forced refusal — the status
    // code is the point, never the answer — so one marker scopes cleanup to
    // exactly the rows this suite could have written.
    await db.deleteFrom('queries').where('question', '=', QUESTION).execute();
    await app.close();
  });

  async function askOnce(address: string, route = '/ask'): Promise<number> {
    const response = await request(server)
      .post(route)
      .set('X-Forwarded-For', address)
      .send({ question: QUESTION });
    return response.status;
  }

  it('throttles /ask once its own configured limit is exceeded', async () => {
    const address = fakeClientAddress();

    for (let i = 0; i < askLimit; i += 1) {
      expect(await askOnce(address)).toBe(200);
    }

    expect(await askOnce(address)).toBe(429);
  });

  it('/ask and /ask/stream share one budget — alternating between them does not double it', async () => {
    const address = fakeClientAddress();
    const half = Math.floor(askLimit / 2);

    for (let i = 0; i < half; i += 1) {
      expect(await askOnce(address, '/ask')).toBe(200);
    }
    for (let i = 0; i < askLimit - half; i += 1) {
      expect(await askOnce(address, '/ask/stream')).toBe(200);
    }

    // The next request, on either route, lands on the same counter the
    // ones before it did, however it was split between the two routes.
    expect(await askOnce(address, '/ask')).toBe(429);
    expect(await askOnce(address, '/ask/stream')).toBe(429);
  });

  it('a distinct route is unaffected by /ask’s limit being exhausted', async () => {
    const address = fakeClientAddress();

    for (let i = 0; i < askLimit; i += 1) {
      expect(await askOnce(address)).toBe(200);
    }
    expect(await askOnce(address)).toBe(429);

    // Same client address, a route with no override of its own — the
    // default bucket, at THROTTLE_DEFAULT_PER_MINUTE, and a different key
    // (this route folds its own handler name in) than /ask's exhausted one.
    await request(server)
      .get('/sources')
      .set('X-Forwarded-For', address)
      .expect(200);
  });

  it('a different client address gets its own, unexhausted counter', async () => {
    const exhausted = fakeClientAddress();
    for (let i = 0; i < askLimit; i += 1) {
      expect(await askOnce(exhausted)).toBe(200);
    }
    expect(await askOnce(exhausted)).toBe(429);

    const fresh = fakeClientAddress();
    expect(await askOnce(fresh)).toBe(200);
  });

  it('throttles /ingest at its own, tighter limit, before the request body is even validated', async () => {
    const address = fakeClientAddress();

    // An empty body fails ingestRequestSchema's own validation (400) — but
    // that check runs inside the handler, after the guard, so a rejected
    // request still counts as a hit. This proves the guard runs ahead of
    // any handler logic, without spending a real embedding or holding a
    // lease to do it.
    for (let i = 0; i < ingestLimit; i += 1) {
      await request(server)
        .post('/ingest')
        .set('X-Forwarded-For', address)
        .send({})
        .expect(400);
    }

    await request(server)
      .post('/ingest')
      .set('X-Forwarded-For', address)
      .send({})
      .expect(429);
  });

  // GET /health has its own ceiling (@Throttle(HEALTH_THROTTLE) in
  // health.controller.ts), distinct from both the default bucket and no
  // limit at all. It is polled on a schedule outside anyone's control — a
  // load balancer, an orchestrator's liveness probe, an uptime monitor —
  // usually all arriving as one address, which is why the ceiling is high;
  // but it still runs a Postgres query and a Redis PING on every call, so
  // one client looping it without any bound would generate unbounded load
  // on both. Exceeding *this suite's own* (deliberately small, distinct
  // from THROTTLE_DEFAULT_PER_MINUTE) health ceiling, not the default
  // bucket's, is what proves it is neither of those two things.
  it('throttles /health past its own ceiling, distinct from the default bucket', async () => {
    const address = fakeClientAddress();

    for (let i = 0; i < healthLimit; i += 1) {
      await request(server)
        .get('/health')
        .set('X-Forwarded-For', address)
        .expect(200);
    }

    await request(server)
      .get('/health')
      .set('X-Forwarded-For', address)
      .expect(429);
  });

  // The whole point of a hop count over `true`: a real reverse proxy
  // *appends* the address it received the connection from, rather than
  // replacing whatever the client already sent — so the entry a client can
  // forge always ends up to the *left* of the one the trusted proxy itself
  // contributed. With TRUST_PROXY=1, Express is trusting exactly one hop,
  // so it reads req.ip from the *right-most* X-Forwarded-For entry and
  // ignores anything further left — which this proves directly: the
  // left-most (forged) part changes on every request below, the right-most
  // (the part standing in for what a real proxy would have appended) does
  // not, and the bucket only reacts to the latter. Because TRUST_PROXY is
  // now applied by TrustProxyBootstrap rather than a manual call in this
  // file's own setup, this scenario doubles as live proof that the wiring
  // actually runs on its own.
  it('ignores a forged left-most X-Forwarded-For entry, honouring only the right-most one', async () => {
    const trusted = fakeClientAddress();

    for (let i = 0; i < askLimit; i += 1) {
      const forged = fakeClientAddress();
      const response = await request(server)
        .post('/ask')
        .set('X-Forwarded-For', `${forged}, ${trusted}`)
        .send({ question: QUESTION });
      expect(response.status).toBe(200);
    }

    // The (askLimit + 1)th request, with yet another forged left-most
    // value but the same trusted right-most one, still lands on the same,
    // now-exhausted counter.
    const oneMoreForged = fakeClientAddress();
    const blocked = await request(server)
      .post('/ask')
      .set('X-Forwarded-For', `${oneMoreForged}, ${trusted}`)
      .send({ question: QUESTION });
    expect(blocked.status).toBe(429);

    // Control: a genuinely different right-most (trusted) address is a
    // genuinely different counter, unexhausted by any of the above.
    const otherTrusted = fakeClientAddress();
    const fresh = await request(server)
      .post('/ask')
      .set('X-Forwarded-For', `${fakeClientAddress()}, ${otherTrusted}`)
      .send({ question: QUESTION });
    expect(fresh.status).toBe(200);
  });
});
