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
  await app.listen(config.get('PORT', { infer: true }));
}

// A rejection here (EADDRINUSE, a provider factory throwing, …) happens
// before Nest has anything registered to catch it, so without this it
// surfaces as a raw unhandled-rejection stack instead of a clean exit.
bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(describeError(error));
  process.exit(1);
});
