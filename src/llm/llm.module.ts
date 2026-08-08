import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { Env } from '../common/config/env.schema';
import { parseLlmChain } from './llm-chain';
import { LLM } from './llm.types';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

@Global()
@Module({
  providers: [
    {
      provide: LLM,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<Env, true>,
      ): OpenAiCompatibleProvider => {
        // The router that walks the whole chain lands in a later task; for
        // now the module still calls exactly one provider, so it only ever
        // needs the chain's first link. Config validation already parsed
        // and key-checked LLM_CHAIN at boot, so a parse failure here would
        // mean that guarantee broke, not that this value is unvalidated.
        const [firstLink] = parseLlmChain(
          config.get('LLM_CHAIN', { infer: true }),
        );
        if (!firstLink) {
          throw new Error('LLM_CHAIN produced no links');
        }
        const model = firstLink.model;
        const client = new OpenAI({
          apiKey: config.get('OPENAI_API_KEY', { infer: true }),
          timeout: config.get('ANSWER_TIMEOUT_MS', { infer: true }),
        });

        new Logger('Llm').log(`answering with ${model}`);

        return new OpenAiCompatibleProvider(client, 'openai', model);
      },
    },
  ],
  exports: [LLM],
})
export class LlmModule {}
