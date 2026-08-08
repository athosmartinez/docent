/**
 * The pg driver has no parser for pgvector's type, so a `vector` column arrives
 * and departs as its text literal (`'[0.1,0.2]'`) rather than as number[].
 * Conversion is explicit in both directions so a malformed value fails here
 * instead of inside PostgreSQL.
 */
export function toVectorLiteral(values: number[]): string {
  if (values.length === 0) {
    throw new Error('cannot store an empty vector');
  }

  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`vector contains a non-finite value: ${String(value)}`);
    }
  }

  return `[${values.join(',')}]`;
}
