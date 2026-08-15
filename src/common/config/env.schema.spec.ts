import { validateEnv } from './env.schema';

const valid = {
  DATABASE_URL: 'postgresql://docent:docent@localhost:5432/docent',
  REDIS_URL: 'redis://localhost:6379',
  OPENAI_API_KEY: 'sk-test-key',
};

describe('validateEnv', () => {
  it('applies defaults for the optional variables', () => {
    const env = validateEnv({ ...valid });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('coerces PORT from its string form', () => {
    const env = validateEnv({ ...valid, PORT: '8080' });

    expect(env.PORT).toBe(8080);
  });

  it('names the offending variable when one is missing', () => {
    expect(() => validateEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a malformed URL', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: 'not-a-url' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('rejects a PORT above the valid range', () => {
    expect(() => validateEnv({ ...valid, PORT: '99999' })).toThrow(/PORT/);
  });

  it('rejects a DATABASE_URL with the wrong protocol', () => {
    expect(() =>
      validateEnv({ ...valid, DATABASE_URL: 'https://example.com' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects a REDIS_URL with the wrong protocol', () => {
    expect(() =>
      validateEnv({ ...valid, REDIS_URL: 'http://localhost:6379' }),
    ).toThrow(/REDIS_URL/);
  });

  it('rejects a missing OPENAI_API_KEY by name', () => {
    const withoutKey = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== 'OPENAI_API_KEY'),
    );

    expect(() => validateEnv(withoutKey)).toThrow(/OPENAI_API_KEY/);
  });

  it('defaults the embedding model and dimensionality', () => {
    const env = validateEnv({ ...valid });

    expect(env.EMBEDDING_MODEL).toBe('text-embedding-3-large');
    expect(env.EMBEDDING_DIMENSIONS).toBe(3072);
  });

  it('refuses a dimensionality the chunks table cannot store', () => {
    expect(() =>
      validateEnv({ ...valid, EMBEDDING_DIMENSIONS: '1536' }),
    ).toThrow(/EMBEDDING_DIMENSIONS/);
  });

  // Cosine distance never exceeds 2, so a configured value at or above it
  // would admit every question regardless of how far the nearest chunk
  // actually is — silently disabling refusal rather than failing at boot.
  it('rejects a GROUNDING_MAX_DISTANCE at the cosine-distance ceiling', () => {
    expect(() =>
      validateEnv({ ...valid, GROUNDING_MAX_DISTANCE: '2' }),
    ).toThrow(/GROUNDING_MAX_DISTANCE/);
  });

  it('accepts a GROUNDING_MAX_DISTANCE just under the ceiling', () => {
    const env = validateEnv({ ...valid, GROUNDING_MAX_DISTANCE: '1.9999' });

    expect(env.GROUNDING_MAX_DISTANCE).toBe(1.9999);
  });

  it('defaults CACHE_EMBEDDING_TTL_S to thirty days', () => {
    const env = validateEnv({ ...valid });

    expect(env.CACHE_EMBEDDING_TTL_S).toBe(2_592_000);
  });

  it('coerces CACHE_EMBEDDING_TTL_S from its string form', () => {
    const env = validateEnv({ ...valid, CACHE_EMBEDDING_TTL_S: '60' });

    expect(env.CACHE_EMBEDDING_TTL_S).toBe(60);
  });

  it('rejects a non-positive CACHE_EMBEDDING_TTL_S', () => {
    expect(() => validateEnv({ ...valid, CACHE_EMBEDDING_TTL_S: '0' })).toThrow(
      /CACHE_EMBEDDING_TTL_S/,
    );
  });
});

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
  REDIS_URL: 'redis://localhost:6379',
  OPENAI_API_KEY: 'sk-test',
};

describe('validateEnv — the provider chain', () => {
  it('accepts a chain whose providers all have keys', () => {
    const env = validateEnv({
      ...base,
      OPENROUTER_API_KEY: 'or-test',
      LLM_CHAIN: 'openai:gpt-4.1-mini,openrouter:google/gemini-2.5-flash',
    });

    expect(env.LLM_CHAIN).toBe(
      'openai:gpt-4.1-mini,openrouter:google/gemini-2.5-flash',
    );
  });

  // Failing here rather than on the first request is the whole point: a
  // missing key turns the fallback link into a link that always fails, and
  // that is indistinguishable from a healthy chain until the primary breaks
  // — which is exactly when the fallback was supposed to save you.
  it('refuses a chain naming a provider with no key', () => {
    expect(() =>
      validateEnv({ ...base, LLM_CHAIN: 'openai:gpt-4.1-mini,openrouter:x' }),
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  it('refuses a malformed chain, reporting why the parser rejected it', () => {
    expect(() => validateEnv({ ...base, LLM_CHAIN: 'openai:' })).toThrow(
      /provider:model/i,
    );
  });

  it('refuses a chain that repeats a provider:model pair', () => {
    expect(() =>
      validateEnv({ ...base, LLM_CHAIN: 'openai:m,openai:m' }),
    ).toThrow(/repeated/i);
  });
});
