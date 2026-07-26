/**
 * Produces a non-empty, human-readable description of a thrown value.
 *
 * Deliberately avoids `instanceof Error`: it is realm-sensitive, so an error
 * built by Node's own internals (or replayed through a vm context, as Jest
 * does) can be a perfectly normal error object that still fails the check.
 * Duck-typing on `.message`/`.code`/`.errors` works regardless of which
 * realm produced the value.
 *
 * It also does not stop at `.message` alone. Node's happy-eyeballs connect
 * failure — the one a stopped dependency actually raises — is an
 * `AggregateError` whose own `.message` is an empty string; the useful
 * detail (`ECONNREFUSED`, the address that refused the connection) lives on
 * `.code` and the nested `.errors[]`.
 */
export function describeError(error: unknown): string {
  if (isRecord(error)) {
    const message = nonEmptyString(error.message);
    if (message) {
      return message;
    }

    const details: string[] = [];

    const code = nonEmptyString(error.code);
    if (code) {
      details.push(code);
    }

    if (Array.isArray(error.errors)) {
      for (const inner of error.errors) {
        const innerMessage = isRecord(inner)
          ? nonEmptyString(inner.message)
          : undefined;
        if (innerMessage) {
          details.push(innerMessage);
        }
      }
    }

    if (details.length > 0) {
      return details.join('; ');
    }
  }

  const fallback = String(error);
  return fallback.length > 0 ? fallback : 'unknown error';
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
