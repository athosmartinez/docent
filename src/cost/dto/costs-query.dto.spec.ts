import { costsQuerySchema } from './costs-query.dto';

describe('costsQuerySchema', () => {
  it('accepts an absent window, leaving both bounds undefined', () => {
    const result = costsQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.from).toBeUndefined();
    expect(result.data.to).toBeUndefined();
  });

  it('coerces both bounds to Date instances', () => {
    const result = costsQuerySchema.safeParse({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.from).toBeInstanceOf(Date);
    expect(result.data.to).toBeInstanceOf(Date);
  });

  it('rejects a value that does not parse as a date', () => {
    const result = costsQuerySchema.safeParse({ from: 'not-a-date' });

    expect(result.success).toBe(false);
  });

  it('rejects to before from', () => {
    const result = costsQuerySchema.safeParse({
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects to equal to from — "after" is strict', () => {
    const result = costsQuerySchema.safeParse({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('accepts either bound given alone', () => {
    expect(
      costsQuerySchema.safeParse({ from: '2026-01-01T00:00:00.000Z' }).success,
    ).toBe(true);
    expect(
      costsQuerySchema.safeParse({ to: '2026-01-01T00:00:00.000Z' }).success,
    ).toBe(true);
  });
});
