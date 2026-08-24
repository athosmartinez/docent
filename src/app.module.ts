import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module';
import { CacheModule } from './common/cache/cache.module';
import { DatabaseModule } from './common/database/database.module';
import { LogFormatBootstrap } from './common/logging/log-format-bootstrap.provider';
import { RequestIdMiddleware } from './common/logging/request-id.middleware';
import { RedisModule } from './common/redis/redis.module';
import { ThrottlingModule } from './common/throttling/throttling.module';
import { AskModule } from './ask/ask.module';
import { CostModule } from './cost/cost.module';
import { EmbeddingsModule } from './embeddings/embeddings.module';
import { HealthModule } from './health/health.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { LlmModule } from './llm/llm.module';
import { RetrievalModule } from './retrieval/retrieval.module';

@Module({
  imports: [
    AppConfigModule,
    CacheModule,
    DatabaseModule,
    RedisModule,
    ThrottlingModule,
    AskModule,
    CostModule,
    EmbeddingsModule,
    HealthModule,
    IngestionModule,
    LlmModule,
    RetrievalModule,
  ],
  providers: [LogFormatBootstrap],
})
export class AppModule implements NestModule {
  // Applied here, as middleware, rather than as an APP_GUARD or an
  // interceptor: middleware runs ahead of Nest's own guard/interceptor
  // pipeline, so even a request the ThrottlerGuard rejects still gets a
  // request id, echoed back on its 429 response. That much is true and
  // unasserted by any test; what is *not* true is that anything then logs
  // the rejection — ThrottlerException is a plain HttpException, and Nest's
  // built-in exception filter does not log those (only an unhandled,
  // non-HTTP error reaches its logger.error call). A 429 carries a request
  // id a client can report, but nothing here writes a log line to look it
  // up against. `forRoutes('*')` covers every route this app builds from —
  // the chat page, every REST endpoint, /health — with no route added later
  // able to opt out by omission.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
