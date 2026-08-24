import { Logger } from '@nestjs/common';
import { ReplyError as UntypedReplyError } from 'ioredis';
import type Redis from 'ioredis';

import { RedisThrottlerStorage } from './redis-throttler.storage';

// ioredis exports ReplyError typed as `any` — this cast is only so `new
// ReplyError(...)` below doesn't trip the lint rule against unsafely
// constructing an untyped value; instanceof checks in the class under test
// work against the same runtime class regardless.
const ReplyError = UntypedReplyError as new (message: string) => Error;

/**
 * A minimal double for the one thing `RedisThrottlerStorage` calls:
 * `throttleIncrement`, the command `defineCommand` attaches in the
 * constructor. These tests exercise how `increment()` interprets that
 * command's result and errors, not the Lua script's own atomicity or
 * self-healing — a mocked client cannot run real Lua, so those claims are
 * proven for real against a live Redis in
 * `test/redis-throttler-storage.e2e-spec.ts` instead.
 */
function fakeRedis(): {
  defineCommand: jest.Mock;
  throttleIncrement: jest.Mock;
} {
  return {
    defineCommand: jest.fn(),
    throttleIncrement: jest.fn(),
  };
}

function storageWith(
  client: ReturnType<typeof fakeRedis>,
): RedisThrottlerStorage {
  return new RedisThrottlerStorage(client as unknown as Redis);
}

describe('RedisThrottlerStorage', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('registers throttleIncrement on the client it is constructed with', () => {
    const client = fakeRedis();

    storageWith(client);

    expect(client.defineCommand).toHaveBeenCalledWith(
      'throttleIncrement',
      expect.objectContaining({ numberOfKeys: 1 }),
    );
  });

  it('calls throttleIncrement with the namespaced key and the ttl', async () => {
    const client = fakeRedis();
    client.throttleIncrement.mockResolvedValue([1, 60_000]);
    const storage = storageWith(client);

    await storage.increment('client-a', 60_000, 10, 60_000, 'default');

    expect(client.throttleIncrement).toHaveBeenCalledWith(
      'throttle:default:client-a',
      60_000,
    );
  });

  it('reports the totalHits and remaining window the command returns', async () => {
    const client = fakeRedis();
    client.throttleIncrement.mockResolvedValue([3, 45_000]);
    const storage = storageWith(client);

    const record = await storage.increment(
      'client-a',
      60_000,
      10,
      60_000,
      'default',
    );

    expect(record.totalHits).toBe(3);
    expect(record.timeToExpire).toBe(45);
    expect(record.isBlocked).toBe(false);
  });

  it('falls back to the full window if the command somehow reports no TTL, rather than a negative or permanent deadline', async () => {
    const client = fakeRedis();
    client.throttleIncrement.mockResolvedValue([3, -1]); // Unreachable through the real script; guarded regardless.
    const storage = storageWith(client);

    const record = await storage.increment(
      'client-a',
      60_000,
      10,
      60_000,
      'default',
    );

    expect(record.timeToExpire).toBe(60);
  });

  it('reports isBlocked once totalHits exceeds limit, with the window’s remaining time as the block time', async () => {
    const client = fakeRedis();
    client.throttleIncrement.mockResolvedValue([11, 20_000]);
    const storage = storageWith(client);

    const record = await storage.increment(
      'client-a',
      60_000,
      10,
      60_000,
      'default',
    );

    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(20);
  });

  it('does not block a hit at exactly the limit', async () => {
    const client = fakeRedis();
    client.throttleIncrement.mockResolvedValue([10, 20_000]);
    const storage = storageWith(client);

    const record = await storage.increment(
      'client-a',
      60_000,
      10,
      60_000,
      'default',
    );

    expect(record.isBlocked).toBe(false);
    expect(record.timeToBlockExpire).toBe(0);
  });

  it('scopes the storage key to the throttler name, so two named throttlers never collide on the same tracker', async () => {
    const client = fakeRedis();
    client.throttleIncrement.mockResolvedValue([1, 60_000]);
    const storage = storageWith(client);

    await storage.increment('client-a', 60_000, 10, 60_000, 'ask');

    expect(client.throttleIncrement).toHaveBeenCalledWith(
      'throttle:ask:client-a',
      60_000,
    );
  });

  it('fails open — resolves an unblocked, zero-hit record instead of rejecting — when Redis is unreachable', async () => {
    const client = fakeRedis();
    client.throttleIncrement.mockRejectedValue(new Error('ECONNREFUSED'));
    const storage = storageWith(client);

    const record = await storage.increment(
      'client-a',
      60_000,
      10,
      60_000,
      'default',
    );

    expect(record).toEqual({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(warn).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  // The regression this whole class exists to avoid repeating: a Redis
  // that received the command and rejected it (wrong arity against an old
  // server, a broken script, a disallowed EVAL) failed open exactly like an
  // unreachable one, logged at the same severity — a genuine bug in this
  // class read identically to an ordinary Redis blip in the logs.
  it('fails open but logs at error, not warn, when Redis rejects the command outright', async () => {
    const client = fakeRedis();
    client.throttleIncrement.mockRejectedValue(
      new ReplyError('ERR wrong number of arguments'),
    );
    const storage = storageWith(client);

    const record = await storage.increment(
      'client-a',
      60_000,
      10,
      60_000,
      'default',
    );

    expect(record.isBlocked).toBe(false);
    expect(record.totalHits).toBe(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('a bug in the script'),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  // The specific defect this fix closes: Redis returns a ReplyError for OOM
  // too, not only for a bug in this class's own script — and the old
  // wording told an operator "not an outage" for a condition that plainly
  // is one, sending them to read code that was never the problem. Asserted
  // on the message's *content*, not merely that error() was called: a
  // mutation that swapped this branch's wording for the generic one below
  // would still fail open exactly the same way and pass every assertion
  // that only checks isBlocked/totalHits.
  it('logs the OOM wording, not the script-bug wording, when Redis rejects the command for being out of memory', async () => {
    const client = fakeRedis();
    // Redis's actual reply text for this condition, reproduced verbatim —
    // see redis-throttler.storage.ts's isOutOfMemory comment for where it
    // was measured.
    client.throttleIncrement.mockRejectedValue(
      new ReplyError("OOM command not allowed when used memory > 'maxmemory'."),
    );
    const storage = storageWith(client);

    const record = await storage.increment(
      'client-a',
      60_000,
      10,
      60_000,
      'default',
    );

    expect(record.isBlocked).toBe(false);
    expect(record.totalHits).toBe(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('out of memory'),
    );
    expect(error).toHaveBeenCalledWith(
      expect.not.stringContaining('a bug in the script'),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  // Distinct from a plain unreachable Redis: the connection accepted the
  // command, so this is a timeout, not a refusal — REDIS_TIMEOUT_MS's own
  // comment records what was measured to size the bound this exercises.
  it('fails open when Redis does not answer within the bound, logging that it was specifically a timeout', async () => {
    const client = fakeRedis();
    // Never resolves — simulates a connection that accepted the write but
    // never answers, which withTimeout exists to bound.
    client.throttleIncrement.mockImplementation(
      () => new Promise(() => undefined),
    );
    const storage = storageWith(client);

    const record = await storage.increment(
      'client-a',
      60_000,
      10,
      60_000,
      'default',
    );

    expect(record).toEqual({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('did not get an answer from Redis'),
    );
  }, 3_000);

  // The twin of the timeout test above: a rejection that is neither a
  // ReplyError nor a timeout (a dropped connection, say) still fails open
  // and still warns, but with the plain "failed" wording — not the timeout
  // wording, which would misreport an outage as a capacity problem.
  it('logs the plain unreachable wording, not the timeout wording, for a non-timeout rejection', async () => {
    const client = fakeRedis();
    client.throttleIncrement.mockRejectedValue(new Error('ECONNREFUSED'));
    const storage = storageWith(client);

    await storage.increment('client-a', 60_000, 10, 60_000, 'default');

    expect(warn).toHaveBeenCalledWith(
      expect.not.stringContaining('did not get an answer from Redis'),
    );
  });
});
