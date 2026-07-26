import { describeError } from './describe-error';

describe('describeError', () => {
  it('prefers a non-empty message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the nested .errors[] messages when the top-level message is empty', () => {
    // Mirrors Node's happy-eyeballs connect failure: an AggregateError whose
    // own .message is empty, with the real detail on .code and .errors[].
    const error = new AggregateError(
      [
        new Error('connect ECONNREFUSED ::1:5432'),
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      ],
      '',
    );

    const description = describeError(error);

    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain('ECONNREFUSED');
    expect(description).toContain('127.0.0.1:5432');
  });

  it('falls back to .code when there is no message and no nested errors', () => {
    const error = Object.assign(new Error(''), { code: 'ECONNREFUSED' });

    const description = describeError(error);

    expect(description.length).toBeGreaterThan(0);
    expect(description).toBe('ECONNREFUSED');
  });

  it('describes a non-Error thrown value', () => {
    const description = describeError('connection reset');

    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain('connection reset');
  });

  it('never returns an empty string, even for an empty thrown value', () => {
    expect(describeError('').length).toBeGreaterThan(0);
    expect(describeError(new Error('')).length).toBeGreaterThan(0);
  });

  it('handles a null-prototype object with no properties to read', () => {
    expect(describeError(Object.create(null)).length).toBeGreaterThan(0);
  });

  it('handles a non-callable toString alongside an empty message', () => {
    const error = { toString: null, message: '' };

    expect(describeError(error).length).toBeGreaterThan(0);
  });

  it('handles a Symbol.toPrimitive that throws', () => {
    const error = {
      [Symbol.toPrimitive]() {
        throw new Error('x');
      },
    };

    expect(describeError(error).length).toBeGreaterThan(0);
  });

  it('handles a message getter that throws', () => {
    const error = {
      get message(): string {
        throw new Error('x');
      },
    };

    expect(describeError(error).length).toBeGreaterThan(0);
  });

  it('handles a circular structure without throwing or hanging', () => {
    const error: Record<string, unknown> = { message: 'circular' };
    error.self = error;

    expect(describeError(error)).toBe('circular');
  });
});
