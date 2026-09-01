/**
 * Thrown when `withTimeout`'s deadline fires first. A distinct class, not a
 * plain `Error`, so a caller that cares can tell "the promise never settled
 * within the bound" apart from whatever the underlying promise itself might
 * reject with — a timeout against a reachable dependency is a different
 * signal (the dependency is slow, or the caller's bound is too tight) from
 * that dependency being unreachable or refusing the request outright.
 */
export class TimeoutError extends Error {}

/**
 * Bounds a promise by a deadline. A dependency that accepts a TCP connection but
 * never answers would otherwise hang the caller indefinitely, since neither the
 * pg pool nor ioredis fails such a request on its own.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`timed out after ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
