import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../common/config/env.schema';
import { RetrievalRepository } from './retrieval.repository';
import { RetrievalService } from './retrieval.service';

const numberFromConfig = (
  key: 'RETRIEVAL_TOP_N' | 'RETRIEVAL_TOP_K' | 'RRF_K',
) => ({
  provide: key,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): number =>
    config.get(key, { infer: true }),
});

@Module({
  providers: [
    RetrievalRepository,
    RetrievalService,
    numberFromConfig('RETRIEVAL_TOP_N'),
    numberFromConfig('RETRIEVAL_TOP_K'),
    numberFromConfig('RRF_K'),
  ],
  exports: [RetrievalRepository, RetrievalService],
})
export class RetrievalModule {}
