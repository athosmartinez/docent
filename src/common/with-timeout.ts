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
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
