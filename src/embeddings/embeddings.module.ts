import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { Env } from '../common/config/env.schema';
import { EMBEDDINGS } from './embeddings.types';
import { OpenAiEmbeddingsProvider } from './openai-embeddings.provider';

@Global()
@Module({
  providers: [
    {
      provide: EMBEDDINGS,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<Env, true>,
      ): OpenAiEmbeddingsProvider => {
        const logger = new Logger('Embeddings');
        const client = new OpenAI({
          apiKey: config.get('OPENAI_API_KEY', { infer: true }),
          timeout: config.get('EMBEDDING_TIMEOUT_MS', { infer: true }),
        });

        logger.log(`using ${config.get('EMBEDDING_MODEL', { infer: true })}`);

        return new OpenAiEmbeddingsProvider(
          client,
          config.get('EMBEDDING_MODEL', { infer: true }),
          config.get('EMBEDDING_DIMENSIONS', { infer: true }),
        );
      },
    },
  ],
  exports: [EMBEDDINGS],
})
export class EmbeddingsModule {}
