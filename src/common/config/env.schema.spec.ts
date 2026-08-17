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

  // The bound is load-bearing, not decorative: THROTTLE_ASK_PER_MINUTE=0
  // makes every request to /ask fail (totalHits, at minimum 1, is always
  // > 0), and a negative or fractional limit is nonsensical for the same
  // comparison. Each of the three keys is checked independently — a fix
  // applied to one by copy-paste, forgotten on the others, still fails
  // here.
  it.each([
    'THROTTLE_DEFAULT_PER_MINUTE',
    'THROTTLE_ASK_PER_MINUTE',
    'THROTTLE_INGEST_PER_MINUTE',
    'THROTTLE_HEALTH_PER_MINUTE',
  ])('rejects a zero %s', (key) => {
    expect(() => validateEnv({ ...valid, [key]: '0' })).toThrow(
      new RegExp(key),
    );
  });

  it.each([
    'THROTTLE_DEFAULT_PER_MINUTE',
    'THROTTLE_ASK_PER_MINUTE',
    'THROTTLE_INGEST_PER_MINUTE',
    'THROTTLE_HEALTH_PER_MINUTE',
  ])('rejects a negative %s', (key) => {
    expect(() => validateEnv({ ...valid, [key]: '-1' })).toThrow(
      new RegExp(key),
    );
  });

  it.each([
    'THROTTLE_DEFAULT_PER_MINUTE',
    'THROTTLE_ASK_PER_MINUTE',
    'THROTTLE_INGEST_PER_MINUTE',
    'THROTTLE_HEALTH_PER_MINUTE',
  ])('rejects a non-integer %s', (key) => {
    expect(() => validateEnv({ ...valid, [key]: '1.5' })).toThrow(
      new RegExp(key),
    );
  });

  it('defaults the four rate limits to 60/10/2/300 per minute', () => {
    const env = validateEnv({ ...valid });

    expect(env.THROTTLE_DEFAULT_PER_MINUTE).toBe(60);
    expect(env.THROTTLE_ASK_PER_MINUTE).toBe(10);
    expect(env.THROTTLE_INGEST_PER_MINUTE).toBe(2);
    expect(env.THROTTLE_HEALTH_PER_MINUTE).toBe(300);
  });

  describe('TRUST_PROXY', () => {
    it('defaults to false', () => {
      const env = validateEnv({ ...valid });

      expect(env.TRUST_PROXY).toBe(false);
    });

    it('parses "false" as the boolean false', () => {
      const env = validateEnv({ ...valid, TRUST_PROXY: 'false' });

      expect(env.TRUST_PROXY).toBe(false);
    });

    // The literal `true` is the one value that makes the limiter fully
    // evadable (see parseTrustProxy's own comment) — every deployment
    // shape below is what boot should accept instead.
    it('rejects the literal true, naming why', () => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(
        /left-most/,
      );
    });

    it('parses a hop count as a number', () => {
      const env = validateEnv({ ...valid, TRUST_PROXY: '1' });

      expect(env.TRUST_PROXY).toBe(1);
    });

    it.each(['loopback', 'linklocal', 'uniquelocal'])(
      'parses the %s preset as itself',
      (preset) => {
        const env = validateEnv({ ...valid, TRUST_PROXY: preset });

        expect(env.TRUST_PROXY).toBe(preset);
      },
    );

    it('parses a comma-separated list of addresses/CIDRs as itself', () => {
      const env = validateEnv({
        ...valid,
        TRUST_PROXY: '10.0.0.1, 172.16.0.0/12',
      });

      expect(env.TRUST_PROXY).toBe('10.0.0.1, 172.16.0.0/12');
    });

    it('rejects a list with an empty entry', () => {
      expect(() =>
        validateEnv({ ...valid, TRUST_PROXY: '10.0.0.1,,172.16.0.0/12' }),
      ).toThrow(/TRUST_PROXY/);
    });
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
