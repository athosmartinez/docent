import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../common/config/env.schema';
import { RetrievalRepository } from './retrieval.repository';
import { RetrievalService } from './retrieval.service';

const numberFromConfig = (
  key:
    | 'RETRIEVAL_TOP_N'
    | 'RETRIEVAL_TOP_K'
    | 'RRF_K'
    | 'EMBEDDING_DIMENSIONS'
    | 'CACHE_EMBEDDING_TTL_S',
) => ({
  provide: key,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): number =>
    config.get(key, { infer: true }),
});

const stringFromConfig = (key: 'EMBEDDING_MODEL') => ({
  provide: key,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): string =>
    config.get(key, { infer: true }),
});

@Module({
  providers: [
    RetrievalRepository,
    RetrievalService,
    numberFromConfig('RETRIEVAL_TOP_N'),
    numberFromConfig('RETRIEVAL_TOP_K'),
    numberFromConfig('RRF_K'),
    numberFromConfig('EMBEDDING_DIMENSIONS'),
    numberFromConfig('CACHE_EMBEDDING_TTL_S'),
    stringFromConfig('EMBEDDING_MODEL'),
  ],
  exports: [RetrievalRepository, RetrievalService],
})
export class RetrievalModule {}
