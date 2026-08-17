import type { ConfigService } from '@nestjs/config';
import type { Application } from 'express';

import type { Env } from './config/env.schema';

/** The forms Express's own `trust proxy` setting accepts, minus `true` — see env.schema.ts's `parseTrustProxy` for why `true` is rejected before this ever runs. */
export type TrustProxySetting = boolean | number | string;

/**
 * Both `INestApplication.getHttpAdapter()` and `HttpAdapterHost.httpAdapter`
 * — the two ways of reaching the underlying Express instance this module
 * needs, from `main.ts`'s bootstrap and from a DI-managed provider
 * respectively — expose this same shape. Typed structurally, against
 * neither specifically, so `applyTrustProxy` accepts whichever one a caller
 * has.
 */
interface HttpAdapterLike {
  getInstance(): unknown;
}

/**
 * `INestApplication` (and `HttpAdapterHost`) have no `set` themselves — the
 * setting belongs to the Express instance underneath. Without it, `req.ip`
 * is the proxy's own address for every request once one sits in front of
 * the service, so every client collapses into the same rate-limit bucket
 * and one client's burst throttles all of them.
 */
export function applyTrustProxy(
  httpAdapter: HttpAdapterLike,
  trustProxy: TrustProxySetting,
): void {
  const httpInstance = httpAdapter.getInstance() as Application;
  httpInstance.set('trust proxy', trustProxy);
}

/**
 * Reads `TRUST_PROXY` and applies it. Called from
 * `TrustProxyBootstrap.onApplicationBootstrap` (see
 * `throttling/trust-proxy-bootstrap.provider.ts`) — a DI-managed provider
 * in `ThrottlingModule`, not a step in `main.ts`'s bootstrap. That is what
 * makes this run identically for every app built from `AppModule`: `main.ts`
 * in production, and — since `onApplicationBootstrap` fires during
 * `app.init()` — every one of this project's e2e suites, all of which call
 * `app.init()` (via `listenOnEphemeralPort`) without ever calling `main.ts`.
 * A step that only `main.ts` remembered to take was, in practice, a step
 * only one of twelve places that build this app ever took.
 */
export function configureTrustProxy(
  httpAdapter: HttpAdapterLike,
  config: ConfigService<Env, true>,
): void {
  applyTrustProxy(httpAdapter, config.get('TRUST_PROXY', { infer: true }));
}
