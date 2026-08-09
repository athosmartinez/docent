import type { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { Env } from '../common/config/env.schema';
import { createLlmProvider } from './llm.module';
import { LlmRouter } from './llm.router';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

// Mocked rather than reached into via a private-field cast: this asserts
// what the factory is actually responsible for — the exact arguments it
// hands its collaborators — and keeps working if LlmRouter's internal
// storage of its links is ever renamed.
jest.mock('openai');
jest.mock('./openai-compatible.provider');

const MockOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;
const MockOpenAiCompatibleProvider =
  OpenAiCompatibleProvider as jest.MockedClass<typeof OpenAiCompatibleProvider>;

function fakeConfig(env: Partial<Env>): ConfigService<Env, true> {
  return {
    get: (key: keyof Env) => env[key],
  } as unknown as ConfigService<Env, true>;
}

beforeEach(() => {
  MockOpenAI.mockClear();
  MockOpenAiCompatibleProvider.mockClear();
});

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

    expect(MockOpenAI).toHaveBeenCalledTimes(1);
    expect(MockOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      timeout: 60_000,
    });

    expect(MockOpenAiCompatibleProvider).toHaveBeenCalledTimes(1);
    expect(MockOpenAiCompatibleProvider).toHaveBeenCalledWith(
      MockOpenAI.mock.instances[0],
      'openai',
      'gpt-4.1-mini',
    );
  });

  // The whole point of the router is that a chain can lead with a provider
  // other than openai — this is the case the pre-router factory refused.
  // Distinct keys and models per link catch a client built for the wrong
  // provider (wrong base URL/key) or a provider built with the wrong link's
  // model, either of which would silently misroute or mis-bill in
  // production.
  it('builds one provider per link, in chain order, with the right base URL, key, model and timeout for each', () => {
    createLlmProvider(
      fakeConfig({
        LLM_CHAIN: 'openrouter:google/gemini-2.5-flash,openai:gpt-4.1-mini',
        OPENAI_API_KEY: 'sk-openai',
        OPENROUTER_API_KEY: 'sk-openrouter',
        ANSWER_TIMEOUT_MS: 45_000,
      }),
    );

    expect(MockOpenAI).toHaveBeenCalledTimes(2);
    expect(MockOpenAI).toHaveBeenNthCalledWith(1, {
      apiKey: 'sk-openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      timeout: 45_000,
    });
    expect(MockOpenAI).toHaveBeenNthCalledWith(2, {
      apiKey: 'sk-openai',
      baseURL: 'https://api.openai.com/v1',
      timeout: 45_000,
    });

    expect(MockOpenAiCompatibleProvider).toHaveBeenCalledTimes(2);
    expect(MockOpenAiCompatibleProvider).toHaveBeenNthCalledWith(
      1,
      MockOpenAI.mock.instances[0],
      'openrouter',
      'google/gemini-2.5-flash',
    );
    expect(MockOpenAiCompatibleProvider).toHaveBeenNthCalledWith(
      2,
      MockOpenAI.mock.instances[1],
      'openai',
      'gpt-4.1-mini',
    );
  });
});
