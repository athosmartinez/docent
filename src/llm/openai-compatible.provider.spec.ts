import type OpenAI from 'openai';

import { OpenAiCompatibleProvider } from './openai-compatible.provider';

const request = { system: 'be brief', user: 'the question' };

function clientReturning(completion: unknown): OpenAI {
  return {
    chat: { completions: { create: jest.fn().mockResolvedValue(completion) } },
  } as unknown as OpenAI;
}

describe('OpenAiCompatibleProvider', () => {
  it('returns the message text, model and finish reason', async () => {
    const client = clientReturning({
      model: 'gpt-4.1-mini-2025-04-14',
      choices: [{ message: { content: 'the answer' }, finish_reason: 'stop' }],
    });

    const result = await new OpenAiCompatibleProvider(
      client,
      'openai',
      'gpt-4.1-mini',
    ).complete(request);

    expect(result.text).toBe('the answer');
    expect(result.model).toBe('gpt-4.1-mini-2025-04-14');
    expect(result.finishReason).toBe('stop');
    expect(result.provider).toBe('openai');
  });

  it('sends system and user as separate messages', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'm',
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    });
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    await new OpenAiCompatibleProvider(
      client,
      'openai',
      'gpt-4.1-mini',
    ).complete(request);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'the question' },
        ],
      }),
    );
  });

  it('throws when the response carries no choice', async () => {
    const client = clientReturning({ model: 'm', choices: [] });

    await expect(
      new OpenAiCompatibleProvider(client, 'openai', 'gpt-4.1-mini').complete(
        request,
      ),
    ).rejects.toThrow(/no choice/i);
  });

  it('throws when the message has no content', async () => {
    const client = clientReturning({
      model: 'm',
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
    });

    await expect(
      new OpenAiCompatibleProvider(client, 'openai', 'gpt-4.1-mini').complete(
        request,
      ),
    ).rejects.toThrow(/no content/i);
  });

  it('yields the text deltas of a stream in order and reports how it finished', async () => {
    // A sync generator is enough: `for await` in the provider consumes sync
    // and async iterables identically, so this fake need not be async too.
    // The leading empty-content chunk mirrors a real stream, whose first
    // chunk is role-only — it must be skipped, not mistaken for the stream's
    // end, so content arriving after it is still received. The trailing
    // chunk carries the finish reason alongside an empty delta, exactly as
    // the real API does.
    function* chunks() {
      yield { choices: [{ delta: {} }] };
      yield { choices: [{ delta: { content: 'he' } }] };
      yield { choices: [{ delta: { content: 'llo' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    }

    const create = jest.fn().mockResolvedValue(chunks());
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const stream = new OpenAiCompatibleProvider(
      client,
      'openai',
      'gpt-4.1-mini',
    ).stream(request);

    const received: string[] = [];
    for await (const delta of stream) {
      received.push(delta);
    }

    expect(received).toEqual(['he', 'llo']);
    expect(stream.outcome().finishReason).toBe('stop');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true }),
    );
  });

  // A completion cut off by the token limit reports `length`, not `stop` —
  // conflating the two would record a truncated answer as though it had
  // completed normally, which is exactly the failure this method exists to
  // prevent.
  it('reports a length finish reason as length, not stop', async () => {
    function* chunks() {
      yield { choices: [{ delta: { content: 'partial' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'length' }] };
    }

    const create = jest.fn().mockResolvedValue(chunks());
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const stream = new OpenAiCompatibleProvider(
      client,
      'openai',
      'gpt-4.1-mini',
    ).stream(request);

    const received: string[] = [];
    for await (const delta of stream) {
      received.push(delta);
    }

    expect(received).toEqual(['partial']);
    expect(stream.outcome().finishReason).toBe('length');
    expect(stream.outcome().finishReason).not.toBe('stop');
  });

  it('normalises usage, including the cached-token detail', async () => {
    const client = clientReturning({
      model: 'gpt-4.1-mini-2025-04-14',
      choices: [{ message: { content: 'a' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 194,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    });

    const result = await new OpenAiCompatibleProvider(
      client,
      'openai',
      'gpt-4.1-mini',
    ).complete(request);

    expect(result.usage).toEqual({
      promptTokens: 194,
      completionTokens: 2,
      cachedTokens: 100,
    });
    expect(result.reportedCostUsd).toBeNull();
  });

  it('reports no usage as null rather than as zeros', async () => {
    const client = clientReturning({
      model: 'm',
      choices: [{ message: { content: 'a' }, finish_reason: 'stop' }],
    });

    const result = await new OpenAiCompatibleProvider(
      client,
      'openai',
      'm',
    ).complete(request);

    // Zeros would be indistinguishable from a genuinely free call and would
    // let the ledger record a measured $0 for something never measured.
    expect(result.usage).toBeNull();
  });

  it('carries the cost a provider reports, in the field reserved for it', async () => {
    const client = clientReturning({
      model: 'google/gemini-2.5-flash',
      choices: [{ message: { content: 'a' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.000123 },
    });

    const result = await new OpenAiCompatibleProvider(
      client,
      'openrouter',
      'google/gemini-2.5-flash',
    ).complete(request);

    expect(result.reportedCostUsd).toBe(0.000123);
    expect(result.usage?.cachedTokens).toBe(0);
  });

  it('asks for usage on a stream and reports it in the outcome', async () => {
    function* chunks() {
      yield { choices: [{ delta: { content: 'hi' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      yield {
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 1, cost: 0.0001 },
      };
    }

    const create = jest.fn().mockResolvedValue(chunks());
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const stream = new OpenAiCompatibleProvider(
      client,
      'openrouter',
      'google/gemini-2.5-flash',
    ).stream(request);

    for await (const delta of stream) {
      // Drains the stream so `outcome()` reflects its end; the deltas
      // themselves are covered by the other streaming tests.
      void delta;
    }

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
    expect(stream.outcome()).toEqual({
      model: 'google/gemini-2.5-flash',
      provider: 'openrouter',
      finishReason: 'stop',
      usage: { promptTokens: 7, completionTokens: 1, cachedTokens: 0 },
      reportedCostUsd: 0.0001,
      modelReason: 'primary',
    });
  });
});
