import type { ConfigService } from '@nestjs/config';
import type { HttpAdapterHost } from '@nestjs/core';

import type { Env } from '../config/env.schema';
import { TrustProxyBootstrap } from './trust-proxy-bootstrap.provider';

function fakeHttpAdapterHost(): {
  httpAdapterHost: HttpAdapterHost;
  set: jest.Mock;
} {
  const set = jest.fn();
  const instance = { set };
  const httpAdapterHost = {
    httpAdapter: { getInstance: () => instance },
  } as unknown as HttpAdapterHost;
  return { httpAdapterHost, set };
}

function fakeConfig(
  trustProxy: boolean | number | string,
): ConfigService<Env, true> {
  return {
    get: () => trustProxy,
  } as unknown as ConfigService<Env, true>;
}

describe('TrustProxyBootstrap', () => {
  it('applies TRUST_PROXY to the app’s own http adapter on application bootstrap', () => {
    const { httpAdapterHost, set } = fakeHttpAdapterHost();
    const bootstrap = new TrustProxyBootstrap(httpAdapterHost, fakeConfig(1));

    bootstrap.onApplicationBootstrap();

    expect(set).toHaveBeenCalledWith('trust proxy', 1);
  });

  // A distinct value from the test above, so a mutation hard-coding a
  // fixed setting instead of reading config fails at least one of the two.
  it('applies whatever TRUST_PROXY resolves to, not a fixed value', () => {
    const { httpAdapterHost, set } = fakeHttpAdapterHost();
    const bootstrap = new TrustProxyBootstrap(
      httpAdapterHost,
      fakeConfig('loopback'),
    );

    bootstrap.onApplicationBootstrap();

    expect(set).toHaveBeenCalledWith('trust proxy', 'loopback');
  });
});
