import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

import type { Env } from '../config/env.schema';
import { ASK_THROTTLE } from '../../ask/ask.controller';
import { HEALTH_THROTTLE } from '../../health/health.controller';
import { INGEST_THROTTLE } from '../../ingestion/ingestion.controller';
import {
  createThrottlerOptions,
  MS_PER_MINUTE,
  sharedBucketKey,
  throttleLimits,
} from './throttling.module';
import { RedisThrottlerStorage } from './redis-throttler.storage';

// Four distinct values, one per limit, deliberately not sharing a digit
// pattern with each other. A bug that reads the wrong key (default sourced
// from THROTTLE_ASK_PER_MINUTE, say, or ask and ingest swapped) fails one of
// these assertions; two suites that both used, say, 10 for every limit would
// pass regardless of which config key actually fed which output.
const CONFIG: Record<string, unknown> = {
  THROTTLE_DEFAULT_PER_MINUTE: 111,
  THROTTLE_ASK_PER_MINUTE: 222,
  THROTTLE_INGEST_PER_MINUTE: 333,
  THROTTLE_HEALTH_PER_MINUTE: 444,
};

function fakeConfig(
  overrides: Record<string, unknown> = {},
): ConfigService<Env, true> {
  const values = { ...CONFIG, ...overrides };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<Env, true>;
}

// RedisThrottlerStorage's own constructor calls client.defineCommand(...)
// to register the Lua script it runs increment() through — a bare `{}`
// stood in for the client before that existed and no longer does.
function fakeRedisClient(): Redis {
  return { defineCommand: jest.fn() } as unknown as Redis;
}

describe('createThrottlerOptions', () => {
  it('sources the default throttler’s limit from THROTTLE_DEFAULT_PER_MINUTE, not from an ask/ingest override', () => {
    const options = createThrottlerOptions(fakeConfig(), fakeRedisClient());

    expect(Array.isArray(options)).toBe(false);
    if (Array.isArray(options)) throw new Error('unreachable');
    expect(options.throttlers).toEqual([
      { name: 'default', ttl: 60_000, limit: 111 },
    ]);
  });

  it('backs the throttlers with RedisThrottlerStorage over the injected client', () => {
    const client = fakeRedisClient();
    const options = createThrottlerOptions(fakeConfig(), client);

    if (Array.isArray(options)) throw new Error('unreachable');
    expect(options.storage).toBeInstanceOf(RedisThrottlerStorage);
  });

  it('populates throttleLimits from THROTTLE_ASK_PER_MINUTE, THROTTLE_INGEST_PER_MINUTE and THROTTLE_HEALTH_PER_MINUTE, not each other', () => {
    createThrottlerOptions(fakeConfig(), fakeRedisClient());

    expect(throttleLimits.askPerMinute).toBe(222);
    expect(throttleLimits.ingestPerMinute).toBe(333);
    expect(throttleLimits.healthPerMinute).toBe(444);
  });

  // A kill switch keyed on a real deployment's own NODE_ENV
  // (`skipIf: () => config.get('NODE_ENV') === 'production'`, say) passes
  // every other test here, tsc, lint, and the full unit and e2e suites —
  // it is a total, silent disabling of the limiter, provable only by an
  // invocation nobody runs. This kills the whole class of that bug rather
  // than one instance of it: the factory must not return a `skipIf` at
  // all, not merely one that happens not to fire under whatever NODE_ENV
  // the test itself runs under.
  it('returns no skipIf at all', () => {
    const options = createThrottlerOptions(fakeConfig(), fakeRedisClient());

    if (Array.isArray(options)) throw new Error('unreachable');
    expect(options.skipIf).toBeUndefined();
  });
});

describe('sharedBucketKey', () => {
  const context = {} as never;

  it('produces the same key for the same bucket and tracker, called twice', () => {
    const generateKey = sharedBucketKey('ask');

    const first = generateKey(context, '203.0.113.5', 'default');
    const second = generateKey(context, '203.0.113.5', 'default');

    expect(first).toBe(second);
  });

  it('does not embed the raw tracker in the key it produces', () => {
    const generateKey = sharedBucketKey('ask');
    const tracker = '203.0.113.5';

    const key = generateKey(context, tracker, 'default');

    expect(key).not.toContain(tracker);
  });

  it('produces different keys for different trackers under the same bucket', () => {
    const generateKey = sharedBucketKey('ask');

    const a = generateKey(context, '203.0.113.5', 'default');
    const b = generateKey(context, '203.0.113.9', 'default');

    expect(a).not.toBe(b);
  });

  it('produces different keys for different buckets under the same tracker', () => {
    const ask = sharedBucketKey('ask')(context, '203.0.113.5', 'default');
    const other = sharedBucketKey('other')(context, '203.0.113.5', 'default');

    expect(ask).not.toBe(other);
  });
});

// The numbers each route's limit resolves to are pinned in
// ask.controller.ts's and ingestion.controller.ts's own throttle overrides
// (via throttleLimits, exercised above); the *window* those numbers count
// against is a separate field on the same object, easy to leave at some
// other value (or to copy from one route to another with the wrong
// duration in tow) without either the limit test or an e2e test that only
// exercises one configured window ever noticing.
describe('per-route throttle windows', () => {
  it('/ask and /ask/stream share a one-minute window', () => {
    expect(ASK_THROTTLE.default.ttl).toBe(MS_PER_MINUTE);
  });

  it('/ingest uses a one-minute window', () => {
    expect(INGEST_THROTTLE.default.ttl).toBe(MS_PER_MINUTE);
  });

  it('/health uses a one-minute window', () => {
    expect(HEALTH_THROTTLE.default.ttl).toBe(MS_PER_MINUTE);
  });
});
