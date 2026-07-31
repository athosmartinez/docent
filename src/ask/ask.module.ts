import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../common/config/env.schema';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { AskController } from './ask.controller';
import { AskRepository } from './ask.repository';
import { AskService } from './ask.service';

@Module({
  imports: [RetrievalModule],
  controllers: [AskController],
  providers: [
    AskRepository,
    AskService,
    {
      provide: 'GROUNDING_FLOOR',
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): number =>
        config.get('GROUNDING_FLOOR', { infer: true }),
    },
  ],
  exports: [AskRepository, AskService],
})
export class AskModule {}
