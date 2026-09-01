import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { describeError } from '../describe-error';
import { REDIS } from '../redis/redis.module';
import { decodeVector, encodeVector } from './cache.keys';

/**
 * A thin, fail-open wrapper over the shared Redis client. A cache miss and a
 * cache that cannot be reached look identical to every caller here — both
 * mean "compute it yourself" — because Redis backs an optimisation, not a
 * dependency: treating it as one would trade a saved API call for an
 * outage. Every read and every write below swallows and logs rather than
 * letting a Redis failure propagate into a request that would otherwise
 * have succeeded.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger('Cache');

  constructor(@Inject(REDIS) private readonly client: Redis) {}

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error: unknown) {
      this.logger.warn(`cache read failed for ${key}: ${describeError(error)}`);
      return null;
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error: unknown) {
      this.logger.warn(
        `cache write failed for ${key}: ${describeError(error)}`,
      );
    }
  }

  async getVector(key: string): Promise<number[] | null> {
    try {
      const raw = await this.client.get(key);
      return raw === null ? null : decodeVector(raw);
    } catch (error: unknown) {
      this.logger.warn(`cache read failed for ${key}: ${describeError(error)}`);
      return null;
    }
  }

  async setVector(
    key: string,
    vector: number[],
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.client.set(key, encodeVector(vector), 'EX', ttlSeconds);
    } catch (error: unknown) {
      this.logger.warn(
        `cache write failed for ${key}: ${describeError(error)}`,
      );
    }
  }
}
