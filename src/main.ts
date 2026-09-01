import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module';
import type { Env } from './common/config/env.schema';
import { describeError } from './common/describe-error';

async function bootstrap(): Promise<void> {
  // bufferLogs queues every log call (module instantiation, route mapping,
  // "Nest application successfully started") instead of printing it
  // immediately. Without it, LOG_FORMAT=json still prints the entire
  // container-build phase through Nest's default ConsoleLogger in
  // ANSI-coloured plain text: LogFormatBootstrap's own
  // onApplicationBootstrap hook — which installs JsonLogger — runs partway
  // through listen()'s internal init(), well after NestFactory.create()
  // has already logged every provider-instantiation line, so nothing short
  // of buffering the whole sequence gets it uniformly through whichever
  // logger LOG_FORMAT actually selects. LogFormatBootstrap itself calls
  // Logger.flush() the moment that selection is made, rather than relying
  // on Nest's own auto-flush (which only fires inside listen()'s *success*
  // callback) — a boot failure between create() resolving and listen()
  // succeeding (a port already in use, a bad config value) would otherwise
  // discard every buffered line, the one written to explain the crash
  // included. One consequence worth knowing, not fixing: every line
  // buffered before that flush shares its `ts` with the flush itself, not
  // its own call time — boot duration and ordering are not recoverable
  // from those lines' timestamps, only from the ones logged afterward.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Without this, OnApplicationShutdown never fires and pooled connections leak
  // when the process receives SIGTERM.
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // LOG_FORMAT itself is applied by AppModule's LogFormatBootstrap (an
  // OnApplicationBootstrap provider), not here — see its own comment for
  // why: this file is the only one of the places that build this app that
  // ever runs a bootstrap function, so a step that lived only here never
  // ran for any e2e suite. TRUST_PROXY's ThrottlingModule.TrustProxyBootstrap
  // made the identical move for the identical reason.

  await app.listen(config.get('PORT', { infer: true }));
}

// A rejection here (EADDRINUSE, a provider factory throwing, …) happens
// before Nest has anything registered to catch it, so without this it
// surfaces as a raw unhandled-rejection stack instead of a clean exit.
bootstrap().catch((error: unknown) => {
  // LogFormatBootstrap's own hook already flushes once the format decision
  // is made, but a failure earlier than that — between create() resolving
  // and listen() ever reaching init(), say a ConfigService read throwing —
  // would otherwise still buffer this very call, the one that exists to
  // explain the crash. Flushing again here is a no-op once nothing is left
  // buffered, and the only thing standing between a real boot failure and
  // total silence otherwise.
  Logger.flush();
  new Logger('Bootstrap').error(describeError(error));
  process.exit(1);
});
