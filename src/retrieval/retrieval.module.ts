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
  // 'EMBEDDING_MODEL' is exported alongside the two services so AskModule
  // (which already imports this module) can fold it into the answer cache
  // key without a second factory reading the same config value — see
  // cache.keys.ts's answeringConfigFingerprint for why it needs to.
  exports: [RetrievalRepository, RetrievalService, 'EMBEDDING_MODEL'],
})
export class RetrievalModule {}
