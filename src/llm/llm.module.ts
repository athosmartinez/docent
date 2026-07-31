import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { Env } from '../common/config/env.schema';
import { LLM } from './llm.types';
import { OpenAiLlmProvider } from './openai-llm.provider';

@Global()
@Module({
  providers: [
    {
      provide: LLM,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): OpenAiLlmProvider => {
        const model = config.get('ANSWER_MODEL', { infer: true });
        const client = new OpenAI({
          apiKey: config.get('OPENAI_API_KEY', { infer: true }),
          timeout: config.get('ANSWER_TIMEOUT_MS', { infer: true }),
        });

        new Logger('Llm').log(`answering with ${model}`);

        return new OpenAiLlmProvider(client, model);
      },
    },
  ],
  exports: [LLM],
})
export class LlmModule {}
