import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module';

@Module({
  imports: [AppConfigModule],
})
export class AppModule {}
