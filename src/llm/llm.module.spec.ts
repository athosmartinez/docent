import type { ConfigService } from '@nestjs/config';

import type { Env } from '../common/config/env.schema';
import { createLlmProvider } from './llm.module';
import { LlmRouter } from './llm.router';
import type { OpenAiCompatibleProvider } from './openai-compatible.provider';

function fakeConfig(env: Partial<Env>): ConfigService<Env, true> {
  return {
    get: (key: keyof Env) => env[key],
  } as unknown as ConfigService<Env, true>;
}

// The router holds its links privately; reaching in here is the only way to
// assert per-link wiring (base URL, key, model) without giving the router
// itself a test-only accessor it has no production need for.
function linksOf(router: LlmRouter): OpenAiCompatibleProvider[] {
  return (router as unknown as { links: OpenAiCompatibleProvider[] }).links;
}

function clientOf(provider: OpenAiCompatibleProvider): {
  apiKey: string;
  baseURL: string;
} {
  return (
    provider as unknown as {
      client: { apiKey: string; baseURL: string };
    }
  ).client;
}

describe('createLlmProvider', () => {
  it('builds a router with one provider for the single-link openai default', () => {
    const router = createLlmProvider(
      fakeConfig({
        LLM_CHAIN: 'openai:gpt-4.1-mini',
        OPENAI_API_KEY: 'sk-test',
        ANSWER_TIMEOUT_MS: 60_000,
      }),
    );

    expect(router).toBeInstanceOf(LlmRouter);
    const links = linksOf(router);
    expect(links).toHaveLength(1);
    expect(clientOf(links[0]!).baseURL).toBe('https://api.openai.com/v1');
    expect(clientOf(links[0]!).apiKey).toBe('sk-test');
  });

  // The whole point of the router is that a chain can lead with a provider
  // other than openai — this is the case the pre-router factory refused.
  it('builds one provider per link, in chain order, with the right base URL and key for each', () => {
    const router = createLlmProvider(
      fakeConfig({
        LLM_CHAIN: 'openrouter:google/gemini-2.5-flash,openai:gpt-4.1-mini',
        OPENAI_API_KEY: 'sk-openai',
        OPENROUTER_API_KEY: 'sk-openrouter',
        ANSWER_TIMEOUT_MS: 60_000,
      }),
    );

    const links = linksOf(router);
    expect(links).toHaveLength(2);

    const first = clientOf(links[0]!);
    expect(first.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(first.apiKey).toBe('sk-openrouter');

    const second = clientOf(links[1]!);
    expect(second.baseURL).toBe('https://api.openai.com/v1');
    expect(second.apiKey).toBe('sk-openai');
  });
});
