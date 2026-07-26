import { Inject, Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import type Redis from 'ioredis';

import { describeError } from '../../common/describe-error';
import { REDIS } from '../../common/redis/redis.module';
import { withTimeout } from '../../common/with-timeout';

const PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS) private readonly client: Redis,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await withTimeout(this.client.ping(), PROBE_TIMEOUT_MS);
      return indicator.up();
    } catch (error) {
      return indicator.down(describeError(error));
    }
  }
}
