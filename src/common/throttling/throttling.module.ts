import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModule,
  type ThrottlerGenerateKeyFunction,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';

import type { Env } from '../config/env.schema';
import { REDIS } from '../redis/redis.module';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { TrustProxyBootstrap } from './trust-proxy-bootstrap.provider';

export const MS_PER_MINUTE = 60_000;

/**
 * Bridges `@Throttle()`'s decorator-time argument evaluation and Nest's
 * DI-time config resolution.
 *
 * `@Throttle({ default: { limit } })` runs as a plain method decorator when
 * a controller file is first imported — via the module graph Node walks
 * before `NestFactory.create`/`Test.createTestingModule(...).compile()` ever
 * runs, so before `ConfigModule.forRoot()` has loaded `.env` into
 * `ConfigService`. A route cannot inject `ConfigService` into a decorator
 * argument for the same reason: there is no DI container yet at the moment
 * the argument is evaluated.
 *
 * `@nestjs/throttler`'s `Resolvable<number>` type exists for exactly this —
 * `limit` may be a function, called per request instead of once at decorator
 * time. The factory below does have `ConfigService`, and Nest finishes
 * initialising every module before `app.listen()` — no request can reach a
 * guard before that factory has run — so a closure reading this object at
 * request time always sees the real, boot-validated value, never the
 * placeholder here.
 */
export const throttleLimits = {
  askPerMinute: 10,
  ingestPerMinute: 2,
  healthPerMinute: 300,
};

/**
 * The default `generateKey` scopes every route to its own bucket — it folds
 * the handler's name into the key, so two routes never share a counter even
 * under the same `@Throttle` limit. That is right for most routes but wrong
 * for a family of routes that spend the same budget through different
 * transports: without a shared key, a client could double an intended limit
 * by alternating between them. `bucket` names that shared counter instead
 * of the handler.
 *
 * Hashed for the same reason the guard's own default `generateKey` hashes
 * its tracker: the un-hashed key would put the client's raw address
 * (`req.ip`, or whatever `X-Forwarded-For` resolves to) directly into a
 * Redis key name and into `RedisThrottlerStorage`'s fail-open log line.
 * `RedisThrottlerStorage.increment` already namespaces every key by
 * `throttlerName`, so this does not repeat it — doing so would only put the
 * same throttler name into the final key twice.
 */
export function sharedBucketKey(bucket: string): ThrottlerGenerateKeyFunction {
  return (_context, tracker) =>
    createHash('sha256').update(`${bucket}:${tracker}`).digest('hex');
}

/**
 * Extracted from the `forRootAsync` call below so the default-vs-override
 * wiring — easy to get backwards, since `default`, `ask`, `ingest` and
 * `health` are four numbers of the same type read from four similarly-named
 * keys — has a unit test that does not require a database or a Redis
 * connection.
 */
export function createThrottlerOptions(
  config: ConfigService<Env, true>,
  redis: Redis,
): ThrottlerModuleOptions {
  throttleLimits.askPerMinute = config.get('THROTTLE_ASK_PER_MINUTE', {
    infer: true,
  });
  throttleLimits.ingestPerMinute = config.get('THROTTLE_INGEST_PER_MINUTE', {
    infer: true,
  });
  throttleLimits.healthPerMinute = config.get('THROTTLE_HEALTH_PER_MINUTE', {
    infer: true,
  });

  return {
    throttlers: [
      {
        name: 'default',
        ttl: MS_PER_MINUTE,
        limit: config.get('THROTTLE_DEFAULT_PER_MINUTE', { infer: true }),
      },
    ],
    storage: new RedisThrottlerStorage(redis),
  };
}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS],
      useFactory: createThrottlerOptions,
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    TrustProxyBootstrap,
  ],
})
export class ThrottlingModule {}
