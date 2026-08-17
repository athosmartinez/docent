import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis, { ReplyError } from 'ioredis';

import { describeError } from '../describe-error';
import { REDIS } from '../redis/redis.module';
import { TimeoutError, withTimeout } from '../with-timeout';

/**
 * `Redis`, plus the one command `defineCommand` attaches to it in the
 * constructor below. Deliberately not a `declare module 'ioredis'`
 * augmentation of `RedisCommander` — that form adds `throttleIncrement` to
 * every `Redis`-typed value in the whole program, including the client
 * `CacheService` and the Redis health indicator inject, neither of which
 * ever has `defineCommand` called on it. A call through either of those
 * would type-check and then throw at runtime; scoping the method to a type
 * only this class's own client is cast to keeps that call impossible to
 * write anywhere else instead of merely unlikely.
 */
type ThrottledRedis = Redis & {
  throttleIncrement(
    key: string,
    ttlMs: number,
  ): Promise<[totalHits: number, pttlMs: number]>;
};

// @nestjs/throttler declares this shape (throttler-storage-record.interface)
// but does not export it from the package's public entry point — deriving
// it from the interface method's own return type keeps this in lockstep
// with whatever the installed version actually expects, rather than
// hand-copying a shape that could drift.
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

// A record returned when Redis cannot be reached at all, or when its reply
// comes back malformed. totalHits: 0 and isBlocked: false both read as
// "this request does not count and is not limited" to the guard, which is
// exactly the fail-open behaviour below exists to produce.
const OPEN: ThrottlerStorageRecord = {
  totalHits: 0,
  timeToExpire: 0,
  isBlocked: false,
  timeToBlockExpire: 0,
};

// The guard calls increment() before every route handler runs, so this is
// on the critical path of 100% of traffic — not a periodic probe like
// HealthModule's own Redis check (which can afford PROBE_TIMEOUT_MS, 3s,
// because it runs on its own schedule, not inline with a user's request).
// A limiter that adds up to 3s to every request during an outage would be
// a worse outage than the one it is trying to prevent from happening to
// something else — but too tight a bound turns ordinary load into the same
// outcome, silently: a slow-but-reachable Redis starts failing open, and a
// warn line in a log nobody is watching is the only trace.
//
// Measured 2026-08-19: 250ms (this constant's first value) was not that
// bound — it tripped under the e2e suite's own parallel load roughly 1 run
// in 8, on a healthy local Redis, Docker on the same machine. Instrumented
// increment() to time the raw client.throttleIncrement() call (bypassing
// this timeout during measurement, so the tail wasn't truncated by the
// thing being measured) and ran the full parallel e2e suite 15 times:
// 2,843 calls, p50 0.86ms, p95 3.6ms, p99 48.5ms, worst observed 152.6ms.
// 1000ms — matching llm.router.ts's CLOSE_TIMEOUT_MS, an existing
// precedent in this codebase for "bound a cleanup that must not hang the
// caller" — gives roughly 6.5x headroom over that worst observed call,
// while still capping an actual outage's cost at well under the
// 2.30–3.23s this bound was introduced to fix.
const REDIS_TIMEOUT_MS = 1_000;

// KEYS[1] the counter key, ARGV[1] the window in milliseconds. INCR and the
// conditional PEXPIRE run inside one EVAL — Redis executes a script as a
// single atomic step, so nothing else this client or any other client sends
// can land in between them, the way it theoretically could between two
// commands in a pipeline (which sends several commands in one write, but
// does not stop Redis's single-threaded loop from servicing another
// connection's command in between processing them). PEXPIRE only fires when
// PTTL reports none (-1: no expiry; -2 cannot happen here, INCR just
// guaranteed the key exists) — checked by value, not by whether this call
// believes it is seeing the first hit, so a key that has hits but somehow
// lost its TTL (the counter survived something the expiry did not) is
// repaired by whichever request notices next, not only by the one that
// originally created it.
//
// EVAL has existed since Redis 2.6; this needs no version floor at all —
// unlike PEXPIRE's NX flag (Redis 7.0+, which this project's own
// docker-compose.yml happens to pin but nothing forces in a real
// deployment), which is what the pipelined design this replaces silently
// depended on. Verified against a real `redis:6-alpine`: the old pipeline's
// `PEXPIRE ... NX` came back a ReplyError ("wrong number of arguments"),
// swallowed by the fail-open catch below into an inert limiter that still
// reported a healthy `GET /health` — this script removes the dependency
// rather than fencing it off with a check.
const THROTTLE_INCREMENT_LUA = `
local totalHits = redis.call('INCR', KEYS[1])
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
return {totalHits, pttl}
`;

/**
 * `ThrottlerStorage` backed by the shared ioredis client, in place of the
 * in-memory default — the default only counts hits seen by the single
 * process holding them, which is wrong the moment the service runs as more
 * than one instance.
 *
 * `ThrottlerGuard.canActivate` calls `increment()` before any route handler
 * runs, on every request. Left to reject, a Redis outage would turn into a
 * 500 at the guard for every request the service receives — the exact
 * "cache outage becomes a total outage" failure `CacheService` exists to
 * avoid, except here it would take down the whole API rather than one
 * optimisation. Redis is not a security boundary for this service: nothing
 * downstream trusts the limiter to keep a client out, only to keep one
 * client's burst from starving the others. So the honest failure mode,
 * matching `CacheService`, is to let the request through and log — never to
 * throw. Left unbounded, a Redis that accepts a TCP connection but never
 * answers would still hang this call (and therefore every request)
 * indefinitely, which `withTimeout` below is what closes.
 *
 * That failure mode is deliberately not the same for every kind of error,
 * though: a `ReplyError` means Redis received the script and rejected it —
 * wrong arity, a Lua error, an ACL that disallows EVAL — which is always a
 * bug in this class, never a transient condition the way a dropped
 * connection or a timeout is. Logging it at the same severity as an
 * unreachable Redis would bury a real bug in ordinary operational noise;
 * see `increment`'s catch block.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('Throttler');
  private readonly client: ThrottledRedis;

  constructor(@Inject(REDIS) client: Redis) {
    // Attaches the method to this specific client instance — not to the
    // ioredis class — so it has to run once per instance. Idempotent to
    // call again (it just redefines the same method), which matters only
    // in tests that construct more than one storage over the same client.
    // The cast is the one place this class asserts the command exists;
    // everywhere below just calls it, typed, on `this.client`.
    client.defineCommand('throttleIncrement', {
      numberOfKeys: 1,
      lua: THROTTLE_INCREMENT_LUA,
    });
    this.client = client as ThrottledRedis;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `throttle:${throttlerName}:${key}`;

    try {
      const [totalHitsRaw, pttlRaw] = await withTimeout(
        this.client.throttleIncrement(redisKey, ttl),
        REDIS_TIMEOUT_MS,
      );

      const totalHits = Number(totalHitsRaw);
      const pttlMs = Number(pttlRaw);
      // The script above only ever returns a positive pttl or the ttl it
      // just set — this fallback is unreachable through it, but keeps a
      // response this method did not itself validate from ever producing a
      // negative or permanent deadline instead of the full window.
      const timeToExpireMs = pttlMs > 0 ? pttlMs : ttl;

      const isBlocked = totalHits > limit;
      const timeToExpire = Math.ceil(timeToExpireMs / 1000);

      // Every throttler this service configures leaves blockDuration at its
      // default, which @nestjs/throttler sets to ttl itself — so the
      // "block" and the counting window are one and the same key, and the
      // block's remaining time is just the window's remaining time. A block
      // that outlives the counting window would need a second key tracked
      // independently of the counter; nothing here ever configures a
      // blockDuration that would make that key observably different, so it
      // is not built. blockDuration is still accepted, to satisfy the
      // interface every caller of this class is written against.
      const timeToBlockExpire = isBlocked ? timeToExpire : 0;

      return { totalHits, timeToExpire, isBlocked, timeToBlockExpire };
    } catch (error: unknown) {
      if (error instanceof ReplyError) {
        this.logger.error(
          `rate limit check rejected by Redis for ${redisKey} — this is a bug in the script or the connection's permissions, not an outage, and it is allowing every request through unthrottled until fixed: ${describeError(error)}`,
        );
      } else if (error instanceof TimeoutError) {
        // Distinct from "Redis is unreachable": the connection accepted the
        // command and just hasn't answered within REDIS_TIMEOUT_MS yet, which
        // a healthy, idle Redis does not do (see that constant's own comment
        // for what was measured). Repeated occurrences of this line are a
        // capacity signal about Redis itself, not a network partition — the
        // fix is headroom or a faster Redis, not a longer timeout here, which
        // would only make every request pay more of the wait before it too
        // falls back to unthrottled.
        this.logger.warn(
          `rate limit check for ${redisKey} did not get an answer from Redis within ${REDIS_TIMEOUT_MS}ms, allowing the request through unthrottled: ${describeError(error)}`,
        );
      } else {
        this.logger.warn(
          `rate limit check failed for ${redisKey}, allowing the request through unthrottled: ${describeError(error)}`,
        );
      }
      return OPEN;
    }
  }
}
