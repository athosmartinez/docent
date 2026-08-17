import type { ConfigService } from '@nestjs/config';

import type { Env } from './config/env.schema';
import { applyTrustProxy, configureTrustProxy } from './trust-proxy';

function fakeHttpAdapter(): {
  httpAdapter: { getInstance: () => unknown };
  set: jest.Mock;
} {
  const set = jest.fn();
  const instance = { set };
  return { httpAdapter: { getInstance: () => instance }, set };
}

function fakeConfig(
  trustProxy: boolean | number | string,
): ConfigService<Env, true> {
  return {
    get: () => trustProxy,
  } as unknown as ConfigService<Env, true>;
}

describe('applyTrustProxy', () => {
  // Both directions matter: `true` behind a real proxy, `false` (the
  // default) everywhere else. A test proving only one gives no signal that
  // the boolean itself — as opposed to some fixed value — reaches Express.
  it('sets trust proxy to true', () => {
    const { httpAdapter, set } = fakeHttpAdapter();

    applyTrustProxy(httpAdapter, true);

    expect(set).toHaveBeenCalledWith('trust proxy', true);
  });

  it('sets trust proxy to false', () => {
    const { httpAdapter, set } = fakeHttpAdapter();

    applyTrustProxy(httpAdapter, false);

    expect(set).toHaveBeenCalledWith('trust proxy', false);
  });

  // A hop count and a preset are the two other shapes env.schema.ts's
  // parseTrustProxy can hand this — proving only the boolean forms would
  // miss a regression that stops passing through a number or a string.
  it('sets trust proxy to a hop count', () => {
    const { httpAdapter, set } = fakeHttpAdapter();

    applyTrustProxy(httpAdapter, 1);

    expect(set).toHaveBeenCalledWith('trust proxy', 1);
  });

  it('sets trust proxy to a preset name', () => {
    const { httpAdapter, set } = fakeHttpAdapter();

    applyTrustProxy(httpAdapter, 'loopback');

    expect(set).toHaveBeenCalledWith('trust proxy', 'loopback');
  });
});

describe('configureTrustProxy', () => {
  // Two different values, so a mutation that ignores config and always
  // applies one fixed setting fails at least one of these.
  it('applies the hop count TRUST_PROXY resolves to', () => {
    const { httpAdapter, set } = fakeHttpAdapter();

    configureTrustProxy(httpAdapter, fakeConfig(1));

    expect(set).toHaveBeenCalledWith('trust proxy', 1);
  });

  it('applies a different TRUST_PROXY value the same way', () => {
    const { httpAdapter, set } = fakeHttpAdapter();

    configureTrustProxy(httpAdapter, fakeConfig('loopback'));

    expect(set).toHaveBeenCalledWith('trust proxy', 'loopback');
  });
});
