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
 *
 * This function is called from places (EventEmitter `'error'` listeners)
 * where throwing is not an option — it would just replace one uncaught
 * exception with another. So every read of a property that could be a
 * throwing getter, and the final `String()` coercion (which throws on a
 * null-prototype object or a hostile `Symbol.toPrimitive`/`toString`), is
 * guarded rather than trusted.
 */
export function describeError(error: unknown): string {
  if (isRecord(error)) {
    const message = safeNonEmptyString(() => error.message);
    if (message) {
      return message;
    }

    const details: string[] = [];

    const code = safeNonEmptyString(() => error.code);
    if (code) {
      details.push(code);
    }

    const inner = safeRead(() => error.errors);
    if (Array.isArray(inner)) {
      for (const item of inner) {
        const innerMessage = isRecord(item)
          ? safeNonEmptyString(() => item.message)
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

  return safeString(error);
}

/** Runs a property read, swallowing a throwing getter into `undefined`. */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function safeNonEmptyString(read: () => unknown): string | undefined {
  const value = safeRead(read);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * `String()` throws instead of returning "[object Object]" when a value has
 * no usable `Symbol.toPrimitive`/`toString`/`valueOf` — a null-prototype
 * object, or one with those overridden to a non-callable or throwing value.
 */
function safeString(value: unknown): string {
  try {
    const fallback = String(value);
    return fallback.length > 0 ? fallback : 'unknown error';
  } catch {
    return 'unknown error';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
