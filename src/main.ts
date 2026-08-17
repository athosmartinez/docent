import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module';
import type { Env } from './common/config/env.schema';
import { describeError } from './common/describe-error';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Without this, OnApplicationShutdown never fires and pooled connections leak
  // when the process receives SIGTERM.
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // TRUST_PROXY is applied by ThrottlingModule's TrustProxyBootstrap
  // (an OnApplicationBootstrap provider), not here — see its own comment
  // for why: this file is the only one of twelve places that build this
  // app that ever ran a bootstrap function, so a step that lived only here
  // never ran for any of the other eleven (every e2e suite).

  await app.listen(config.get('PORT', { infer: true }));
}

// A rejection here (EADDRINUSE, a provider factory throwing, …) happens
// before Nest has anything registered to catch it, so without this it
// surfaces as a raw unhandled-rejection stack instead of a clean exit.
bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(describeError(error));
  process.exit(1);
});
