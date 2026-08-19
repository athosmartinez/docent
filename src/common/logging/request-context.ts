import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Carried through one request's lifetime via `AsyncLocalStorage`, not a
 * parameter threaded through every function signature between the
 * middleware that assigns it and whatever, arbitrarily deep, eventually
 * logs something while handling the request. `AsyncLocalStorage` is what
 * makes that survive an `await` — a plain module-level variable would leak
 * across concurrent requests the moment two overlap on the same event loop,
 * which every route here does under real load.
 */
export interface RequestContextStore {
  readonly requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContextStore>();

/**
 * `undefined` outside a request — at boot, during shutdown, in a rejection
 * handler that runs after the response already went out — which every
 * caller needs to treat as a real, valid outcome rather than a bug: nothing
 * here guarantees a store is active, and pretending otherwise (throwing, or
 * substituting a placeholder id) would make a boot-time log line look like
 * it belongs to some request it never ran inside.
 */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
