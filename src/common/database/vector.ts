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

export function parseVectorLiteral(literal: string): number[] {
  if (!literal.startsWith('[') || !literal.endsWith(']')) {
    throw new Error(`malformed vector literal: ${literal}`);
  }

  const body = literal.slice(1, -1);

  if (body.length === 0) {
    throw new Error('malformed vector literal: empty');
  }

  return body.split(',').map((part) => {
    // Number('') and Number('  ') both coerce to 0, which is finite — an empty
    // segment would otherwise slip past the isFinite guard below as a silent 0.
    if (part.trim().length === 0) {
      throw new Error(`malformed vector literal: ${literal}`);
    }

    const value = Number(part);

    if (!Number.isFinite(value)) {
      throw new Error(`malformed vector literal: ${literal}`);
    }

    return value;
  });
}
