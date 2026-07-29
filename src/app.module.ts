import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module';
import { DatabaseModule } from './common/database/database.module';
import { RedisModule } from './common/redis/redis.module';
import { EmbeddingsModule } from './embeddings/embeddings.module';
import { HealthModule } from './health/health.module';
import { IngestionModule } from './ingestion/ingestion.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    RedisModule,
    EmbeddingsModule,
    HealthModule,
    IngestionModule,
  ],
})
export class AppModule {}
