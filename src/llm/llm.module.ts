import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { Env } from '../common/config/env.schema';
import { parseLlmChain } from './llm-chain';
import { LLM } from './llm.types';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

// The router that walks the whole chain lands in a later task; for now this
// still calls exactly one provider, so it only ever needs the chain's first
// link. Config validation already parsed and key-checked LLM_CHAIN at boot,
// so a parse failure here would mean that guarantee broke, not that this
// value is unvalidated.
//
// A first link naming any provider other than 'openai' is refused rather
// than silently honoured: this client is hardcoded to OpenAI's endpoint and
// key, so building it anyway would send an OpenAI key to OpenAI while
// reporting the answer as though it came from whatever the chain named —
// wrong endpoint, wrong credential, no error. A loud boot failure is the
// correct outcome until the router replaces this factory.
export function createLlmProvider(
  config: ConfigService<Env, true>,
): OpenAiCompatibleProvider {
  const [firstLink] = parseLlmChain(config.get('LLM_CHAIN', { infer: true }));
  if (!firstLink) {
    throw new Error('LLM_CHAIN produced no links');
  }
  if (firstLink.provider !== 'openai') {
    throw new Error(
      `LLM_CHAIN's first link is '${firstLink.provider}:${firstLink.model}', but multi-provider routing is not wired yet — only 'openai' can lead the chain until the router lands`,
    );
  }
  const model = firstLink.model;
  const client = new OpenAI({
    apiKey: config.get('OPENAI_API_KEY', { infer: true }),
    timeout: config.get('ANSWER_TIMEOUT_MS', { infer: true }),
  });

  new Logger('Llm').log(`answering with ${model}`);

  return new OpenAiCompatibleProvider(client, 'openai', model);
}

@Global()
@Module({
  providers: [
    {
      provide: LLM,
      inject: [ConfigService],
      useFactory: createLlmProvider,
    },
  ],
  exports: [LLM],
})
export class LlmModule {}
