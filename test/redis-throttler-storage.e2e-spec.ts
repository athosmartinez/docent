import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

import { AppModule } from '../src/app.module';
import { REDIS } from '../src/common/redis/redis.module';
import { RedisThrottlerStorage } from '../src/common/throttling/redis-throttler.storage';

/**
 * `redis-throttler.storage.spec.ts` mocks the Redis client entirely, so it
 * can only prove how `increment()` interprets a result — never whether the
 * Lua script it calls is genuinely atomic or genuinely self-healing, since
 * a mock cannot run real Lua. This suite runs the real script against the
 * real, shared Redis every e2e suite uses, which is the only way either
 * claim can actually be tested.
 */
describe('RedisThrottlerStorage against a real Redis', () => {
  let app: INestApplication;
  let client: Redis;
  let storage: RedisThrottlerStorage;
  const throttlerName = `e2e-storage-${randomUUID()}`;
  const keysToClean: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    client = app.get<Redis>(REDIS);
    storage = new RedisThrottlerStorage(client);
  });

  afterAll(async () => {
    if (keysToClean.length > 0) {
      await client.del(...keysToClean);
    }
    await app.close();
  });

  // A throttler name unique to this run scopes every key this suite
  // touches away from any other suite's traffic (or a previous run's
  // leftovers) sharing the same Redis; tracking each one as it's built
  // means cleanup never has to guess which keys this suite created.
  function trackedKey(suffix: string): { key: string; redisKey: string } {
    const key = `${throttlerName}-${suffix}`;
    const redisKey = `throttle:${throttlerName}:${key}`;
    keysToClean.push(redisKey);
    return { key, redisKey };
  }

  it('sets an expiry on the very first hit', async () => {
    const { key, redisKey } = trackedKey('first');

    const record = await storage.increment(
      key,
      60_000,
      10,
      60_000,
      throttlerName,
    );

    expect(record.totalHits).toBe(1);
    expect(await client.pttl(redisKey)).toBeGreaterThan(0);
  });

  it('does not refresh the expiry on a later hit', async () => {
    const { key, redisKey } = trackedKey('norefresh');

    await storage.increment(key, 3_000, 10, 3_000, throttlerName);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const record = await storage.increment(
      key,
      3_000,
      10,
      3_000,
      throttlerName,
    );

    // A refreshed window reports the full 3s again (ceil(3000/1000)); the
    // real remaining time, over a second later, rounds down to 2s.
    expect(record.timeToExpire).toBeLessThan(3);
    expect(await client.pttl(redisKey)).toBeGreaterThan(0);
  });

  it('self-heals a key that has hits but lost its TTL', async () => {
    const { key, redisKey } = trackedKey('selfheal');
    // Bypasses the script entirely — a plain SET with no TTL attached,
    // simulating a key an earlier attempt at setting the expiry never
    // reached (the failure mode fix A closes: hits recorded, no TTL).
    await client.set(redisKey, '5');
    expect(await client.pttl(redisKey)).toBe(-1);

    const record = await storage.increment(
      key,
      60_000,
      100,
      60_000,
      throttlerName,
    );

    expect(record.totalHits).toBe(6);
    expect(await client.pttl(redisKey)).toBeGreaterThan(0);
  });

  // The claim a mocked unit test cannot make: INCR and the conditional
  // PEXPIRE happen as one atomic step, not two operations a concurrent
  // caller could interleave with. Run at real concurrency against a real
  // Redis — a non-atomic increment would lose hits (two callers reading
  // the same pre-INCR value) under this; an atomic one cannot.
  it('is atomic under concurrent increments — every hit is counted and the key ends up with an expiry', async () => {
    const { key, redisKey } = trackedKey('concurrent');
    const concurrency = 50;

    await Promise.all(
      Array.from({ length: concurrency }, () =>
        storage.increment(key, 60_000, 1_000_000, 60_000, throttlerName),
      ),
    );

    expect(Number(await client.get(redisKey))).toBe(concurrency);
    expect(await client.pttl(redisKey)).toBeGreaterThan(0);
  });
});
