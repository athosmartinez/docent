import {
  Injectable,
  Logger,
  type LogLevel,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema';
import { JsonLogger } from './json.logger';

/**
 * Installs `JsonLogger` as part of the DI graph itself, rather than as a
 * step in `main.ts`'s `bootstrap()` — the same move `TrustProxyBootstrap`
 * made for `TRUST_PROXY`, and for the identical reason: `main.ts` is the
 * only one of the places that build this app that ever runs a bootstrap
 * function at all. A step that lived only there was, for every e2e suite's
 * own `Test.createTestingModule({ imports: [AppModule] })`, a step that
 * never ran — which is exactly what let an inverted `=== 'json'` check
 * ship with the full suite green: nothing built this app the way
 * `main.ts` does, so nothing exercised which logger a given `LOG_FORMAT`
 * actually selects.
 *
 * `OnApplicationBootstrap` runs during `app.init()`, early enough that no
 * request — real or from a test — can arrive before it does, the same
 * ordering guarantee `TrustProxyBootstrap` relies on.
 *
 * `Logger.flush()` runs unconditionally, whichever branch fired above.
 * `main.ts`'s own `NestFactory.create` passes `{ bufferLogs: true }`: every
 * log call between process start and this hook running is queued rather
 * than printed, and Nest's own auto-flush only fires inside
 * `NestApplication.listen()`'s *success* callback — so a boot failure
 * anywhere between `create()` resolving and `listen()` succeeding (a port
 * already in use, a bad config value, a signal) would otherwise discard
 * every buffered line, the call written to explain the crash included.
 * Flushing here, as early as the format decision can actually be made,
 * shrinks that silent window to container construction alone rather than
 * the entire boot sequence — `main.ts`'s own `bootstrap().catch` flushes
 * again, unconditionally, for whatever this hook never got the chance to
 * run before (a failure between `create()` resolving and `listen()` even
 * reaching `init()`).
 *
 * There is deliberately no restore on shutdown. An earlier version of this
 * class reinstalled `ConsoleLogger` in `OnApplicationShutdown`, reasoning
 * that `Logger.overrideLogger` is process-wide static state that could
 * leak into whichever e2e suite a Jest worker ran next. That reasoning was
 * wrong: Jest gives each spec *file* its own module registry, so
 * `@nestjs/common` — and every static field on its `Logger` class — is a
 * distinct object per file; nothing one file's app installs is visible to
 * another's, reproduced directly with two probe files in one process. The
 * restore was also actively harmful: Nest runs shutdown hooks in ascending
 * distance from the root module, so `AppModule`'s own hook (distance 0)
 * fired *before* `RedisModule`'s and `DatabaseModule`'s (distance 1) —
 * flipping the logger back to `ConsoleLogger` before those two modules'
 * own shutdown-hook warnings (a pool or client that would not close in
 * time) had a chance to log, which is exactly the moment a collector
 * parsing the stream as JSON needs them least dropped. If a single spec
 * file needs the previous logger back between its own tests, that file
 * restores it itself — see `request-correlation.spec.ts`'s `afterEach`.
 */
@Injectable()
export class LogFormatBootstrap implements OnApplicationBootstrap {
  constructor(private readonly config: ConfigService<Env, true>) {}

  onApplicationBootstrap(): void {
    if (this.config.get('LOG_FORMAT', { infer: true }) === 'json') {
      const logger = new JsonLogger();
      const configuredLevels = currentGlobalLevels();
      if (configuredLevels) {
        logger.setLogLevels(configuredLevels);
      }
      Logger.overrideLogger(logger);
    }
    Logger.flush();
  }
}

/**
 * `Logger.logLevels` — what `Logger.overrideLogger(levelsArray)` (or
 * `NestFactory.create(AppModule, { logger: [...] })`) last configured — is
 * `protected static`, with no public getter: `Logger.overrideLogger`
 * itself only ever *installs* a new instance, it never reads a level
 * threshold back off the old one first. Left alone, installing `JsonLogger`
 * here would silently discard any threshold configured before this hook
 * runs, since a fresh `JsonLogger` defaults to every level enabled.
 * `protected` is compile-time only, so reading it through a narrow, local
 * cast — the same kind of one-purpose assertion `RedisThrottlerStorage`
 * makes for `ThrottledRedis`, the one place it asserts a command its own
 * `defineCommand()` call added actually exists — recovers it without a
 * public API to ask Nest for. `undefined` here means exactly what it means
 * to Nest itself: nothing has ever configured a threshold, so `JsonLogger`
 * keeps its own default instead of being handed an empty array that would
 * suppress every level rather than none.
 */
function currentGlobalLevels(): LogLevel[] | undefined {
  return (Logger as unknown as { logLevels?: LogLevel[] }).logLevels;
}
