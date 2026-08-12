import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { Env } from '../common/config/env.schema';
import { missingPrices } from '../cost/cost.calculator';
import { parseLlmChain } from './llm-chain';
import { LlmRouter, type RoutedLink } from './llm.router';
import { LLM } from './llm.types';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

// Every provider the chain can name and the base URL its client talks to.
// Config validation already confirms LLM_CHAIN names only these providers
// and that each one it uses has a key, so this map only needs an entry per
// provider — it is not itself a source of validation.
const BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

// Config validation already parsed and key-checked LLM_CHAIN at boot, so a
// parse failure or a missing key here would mean that guarantee broke, not
// that this value is unvalidated — this factory relies on both rather than
// re-checking them.
export function createLlmProvider(config: ConfigService<Env, true>): LlmRouter {
  const links = parseLlmChain(config.get('LLM_CHAIN', { infer: true }));
  const timeout = config.get('ANSWER_TIMEOUT_MS', { infer: true });

  const keys: Record<string, string | undefined> = {
    openai: config.get('OPENAI_API_KEY', { infer: true }),
    openrouter: config.get('OPENROUTER_API_KEY', { infer: true }),
  };

  const routed: RoutedLink[] = links.map((link) => {
    const client = new OpenAI({
      apiKey: keys[link.provider],
      baseURL: BASE_URLS[link.provider],
      timeout,
    });

    return {
      chain: link,
      provider: new OpenAiCompatibleProvider(client, link.provider, link.model),
    };
  });

  const chainDescription = links
    .map((link) => `${link.provider}:${link.model}`)
    .join(' → ');
  const logger = new Logger('Llm');
  logger.log(`answering via ${chainDescription}`);

  // An unpriced link still answers questions; it just cannot be costed. A
  // warning rather than a boot failure keeps adding a new model as easy as
  // it should be — pricing it can follow once it is live.
  const unpriced = missingPrices(links);
  if (unpriced.length > 0) {
    logger.warn(
      `no price on file for ${unpriced.join(', ')}; their ledger rows will record cost_source: 'unknown'`,
    );
  }

  return new LlmRouter(routed);
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
