import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';

import type { Env } from '../config/env.schema';
import { configureTrustProxy } from '../trust-proxy';

/**
 * Applies `TRUST_PROXY` as part of the DI graph itself, rather than as a
 * step in `main.ts`'s bootstrap. `main.ts` is the only one of twelve places
 * that build this app (production, plus every e2e suite's own
 * `Test.createTestingModule({ imports: [AppModule] })`) that ever ran a
 * bootstrap function at all — the other eleven call `app.init()` directly
 * and never touch `main.ts`, so a step that lived only there was, for every
 * one of them, a step that never ran: `req.ip` came from the raw socket
 * address regardless of what `TRUST_PROXY` said, and nothing exercised the
 * difference.
 *
 * `OnApplicationBootstrap` runs during `app.init()`, before `app.listen()`
 * — early enough that no request, real or from a test, can arrive first.
 * Being a provider Nest resolves for every app built from `AppModule` means
 * this now runs the same way everywhere that happens, main.ts included.
 */
@Injectable()
export class TrustProxyBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    configureTrustProxy(this.httpAdapterHost.httpAdapter, this.config);
  }
}
