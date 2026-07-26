import { validateEnv } from './env.schema';

const valid = {
  DATABASE_URL: 'postgresql://docent:docent@localhost:5432/docent',
  REDIS_URL: 'redis://localhost:6379',
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
});
