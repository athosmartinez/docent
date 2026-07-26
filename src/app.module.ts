import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module';
import { DatabaseModule } from './common/database/database.module';
import { RedisModule } from './common/redis/redis.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [AppConfigModule, DatabaseModule, RedisModule, HealthModule],
})
export class AppModule {}
