import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { CacheService } from './cache.service';

function fakeRedis(): { get: jest.Mock; set: jest.Mock } {
  return { get: jest.fn(), set: jest.fn() };
}

function serviceWith(client: { get: jest.Mock; set: jest.Mock }): CacheService {
  return new CacheService(client as unknown as Redis);
}

describe('CacheService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('getJson', () => {
    it('parses and returns a hit', async () => {
      const client = fakeRedis();
      client.get.mockResolvedValue(JSON.stringify({ a: 1 }));

      const result = await serviceWith(client).getJson<{ a: number }>('key');

      expect(client.get).toHaveBeenCalledWith('key');
      expect(result).toEqual({ a: 1 });
    });

    it('returns null on a miss', async () => {
      const client = fakeRedis();
      client.get.mockResolvedValue(null);

      await expect(serviceWith(client).getJson('key')).resolves.toBeNull();
    });

    it('fails open to null, not to a thrown error, when the read rejects', async () => {
      const client = fakeRedis();
      client.get.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(serviceWith(client).getJson('key')).resolves.toBeNull();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('setJson', () => {
    it('writes the JSON-encoded value with the given TTL', async () => {
      const client = fakeRedis();
      client.set.mockResolvedValue('OK');

      await serviceWith(client).setJson('key', { a: 1 }, 60);

      expect(client.set).toHaveBeenCalledWith(
        'key',
        JSON.stringify({ a: 1 }),
        'EX',
        60,
      );
    });

    it('swallows a write failure instead of throwing', async () => {
      const client = fakeRedis();
      client.set.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        serviceWith(client).setJson('key', { a: 1 }, 60),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('getVector', () => {
    // The expected value is computed independently of the service's own
    // codec so a codec bug (e.g. one that corrupts the value the same way on
    // encode and decode) cannot hide behind a self-referential round-trip.
    it('decodes a hit as float32 values, in order', async () => {
      const vector = [0, 1, -1, 0.5, 123.456];
      const encoded = Buffer.from(Float32Array.from(vector).buffer).toString(
        'base64',
      );
      const client = fakeRedis();
      client.get.mockResolvedValue(encoded);

      const result = await serviceWith(client).getVector('key');

      expect(result).toEqual(Array.from(Float32Array.from(vector)));
    });

    it('returns null on a miss', async () => {
      const client = fakeRedis();
      client.get.mockResolvedValue(null);

      await expect(serviceWith(client).getVector('key')).resolves.toBeNull();
    });

    it('fails open to null when the read rejects', async () => {
      const client = fakeRedis();
      client.get.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(serviceWith(client).getVector('key')).resolves.toBeNull();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('setVector', () => {
    it('writes the base64-encoded float32 bytes with the given TTL', async () => {
      const vector = [0, 1, -1, 0.5, 123.456];
      const expected = Buffer.from(Float32Array.from(vector).buffer).toString(
        'base64',
      );
      const client = fakeRedis();
      client.set.mockResolvedValue('OK');

      await serviceWith(client).setVector('key', vector, 60);

      expect(client.set).toHaveBeenCalledWith('key', expected, 'EX', 60);
    });

    it('swallows a write failure instead of throwing', async () => {
      const client = fakeRedis();
      client.set.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        serviceWith(client).setVector('key', [1, 2, 3], 60),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });
  });
});
