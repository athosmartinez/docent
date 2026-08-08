import type { ConfigService } from '@nestjs/config';

import type { Env } from '../common/config/env.schema';
import { createLlmProvider } from './llm.module';

function fakeConfig(env: Partial<Env>): ConfigService<Env, true> {
  return {
    get: (key: keyof Env) => env[key],
  } as unknown as ConfigService<Env, true>;
}

describe('createLlmProvider', () => {
  it('builds a provider for the single-link openai default', () => {
    const provider = createLlmProvider(
      fakeConfig({
        LLM_CHAIN: 'openai:gpt-4.1-mini',
        OPENAI_API_KEY: 'sk-test',
        ANSWER_TIMEOUT_MS: 60_000,
      }),
    );

    expect(provider).toBeDefined();
  });

  // This factory is hardcoded to OpenAI's endpoint and key. Honouring a
  // first link naming any other provider would send an OpenAI key to
  // OpenAI while reporting the answer as though it came from that other
  // provider — wrong endpoint, wrong credential, no error anywhere. The
  // router replacing this factory is what's actually meant to route; until
  // then a loud boot failure beats a silent misroute.
  it('refuses a chain whose first link is not openai', () => {
    expect(() =>
      createLlmProvider(
        fakeConfig({
          LLM_CHAIN: 'openrouter:google/gemini-2.5-flash',
          OPENAI_API_KEY: 'sk-test',
          ANSWER_TIMEOUT_MS: 60_000,
        }),
      ),
    ).toThrow(/multi-provider routing is not wired yet/);
  });
});
