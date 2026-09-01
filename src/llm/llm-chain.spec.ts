import { parseLlmChain } from './llm-chain';

describe('parseLlmChain', () => {
  it('parses a chain of provider:model pairs', () => {
    expect(
      parseLlmChain('openai:gpt-4.1-mini,openrouter:google/gemini-2.5-flash'),
    ).toEqual([
      { provider: 'openai', model: 'gpt-4.1-mini' },
      { provider: 'openrouter', model: 'google/gemini-2.5-flash' },
    ]);
  });

  // OpenRouter model names carry variant suffixes after a colon. Splitting
  // on every colon truncates the model to 'google/gemini-2.5-flash' and
  // silently routes to a different, billable model than the one configured.
  it('splits on the first colon only, so a model name may contain colons', () => {
    expect(parseLlmChain('openrouter:google/gemini-2.5-flash:free')).toEqual([
      { provider: 'openrouter', model: 'google/gemini-2.5-flash:free' },
    ]);
  });

  it('tolerates whitespace around the separators', () => {
    expect(parseLlmChain(' openai:gpt-4.1-mini , openrouter:x ')).toEqual([
      { provider: 'openai', model: 'gpt-4.1-mini' },
      { provider: 'openrouter', model: 'x' },
    ]);
  });

  it('rejects a trailing comma', () => {
    expect(() => parseLlmChain('openai:gpt-4.1-mini,')).toThrow(
      /empty link.*comma/i,
    );
  });

  it('rejects a leading comma', () => {
    expect(() => parseLlmChain(',openai:gpt-4.1-mini')).toThrow(
      /empty link.*comma/i,
    );
  });

  it('rejects a doubled comma', () => {
    expect(() => parseLlmChain('openai:gpt-4.1-mini,,openrouter:x')).toThrow(
      /empty link.*comma/i,
    );
  });

  it('rejects a whitespace-only segment', () => {
    expect(() => parseLlmChain('openai:gpt-4.1-mini,   ,openrouter:x')).toThrow(
      /empty link.*comma/i,
    );
  });

  it('rejects an empty chain', () => {
    expect(() => parseLlmChain('')).toThrow(/at least one link/i);
  });

  it('rejects a link with no colon', () => {
    expect(() => parseLlmChain('gpt-4.1-mini')).toThrow(/provider:model/i);
  });

  it('rejects a link with an empty model', () => {
    expect(() => parseLlmChain('openai:')).toThrow(/provider:model/i);
  });

  it('rejects an unknown provider', () => {
    expect(() => parseLlmChain('anthropic:claude')).toThrow(/anthropic/);
  });

  // The anti-loop requirement — never retry the same provider+model within
  // one request — is enforced here, as a property of the configured list,
  // rather than as bookkeeping at request time.
  it('rejects a repeated provider:model pair', () => {
    expect(() =>
      parseLlmChain('openai:gpt-4.1-mini,openai:gpt-4.1-mini'),
    ).toThrow(/repeated/i);
  });

  it('allows the same provider twice with different models', () => {
    expect(parseLlmChain('openai:gpt-4.1-mini,openai:gpt-4.1')).toHaveLength(2);
  });
});
