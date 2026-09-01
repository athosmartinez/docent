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
      provide: 'GROUNDING_MAX_DISTANCE',
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): number =>
        config.get('GROUNDING_MAX_DISTANCE', { infer: true }),
    },
    {
      provide: 'CACHE_ANSWER_TTL_S',
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): number =>
        config.get('CACHE_ANSWER_TTL_S', { infer: true }),
    },
    // Folded into the answer cache key (see cache.keys.ts's
    // answeringConfigFingerprint) rather than read only by LlmModule's own
    // factory — the chain determines which model answers, so it is part of
    // what an entry is even an answer to.
    {
      provide: 'LLM_CHAIN',
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): string =>
        config.get('LLM_CHAIN', { infer: true }),
    },
  ],
  exports: [AskRepository, AskService],
})
export class AskModule {}
