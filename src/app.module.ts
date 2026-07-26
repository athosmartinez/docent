import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module';
import { DatabaseModule } from './common/database/database.module';

@Module({
  imports: [AppConfigModule, DatabaseModule],
})
export class AppModule {}
