import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Throttle } from '@nestjs/throttler';

import {
  MS_PER_MINUTE,
  throttleLimits,
} from '../common/throttling/throttling.module';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';

// A load balancer, an orchestrator's liveness probe and an uptime monitor
// all poll this on their own schedule, arriving as one address once
// TRUST_PROXY isn't configured to say otherwise — far more often than
// THROTTLE_DEFAULT_PER_MINUTE assumes, and unrelated to it, so this route
// gets its own ceiling rather than sharing the default bucket. Not
// unlimited, though: every call still runs a Postgres query and a Redis
// PING, so one client looping it with no bound at all would generate
// unbounded load on both. Exported so the window this applies over can be
// pinned the same way ASK_THROTTLE's and INGEST_THROTTLE's are.
export const HEALTH_THROTTLE = {
  default: {
    limit: () => throttleLimits.healthPerMinute,
    ttl: MS_PER_MINUTE,
  },
};

@Controller('health')
export class HealthController {
  // See IngestionService's constructor for why these are explicitly
  // @Inject()-ed instead of left to implicit type-based resolution.
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(DatabaseHealthIndicator)
    private readonly database: DatabaseHealthIndicator,
    @Inject(RedisHealthIndicator) private readonly redis: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @Throttle(HEALTH_THROTTLE)
  check() {
    return this.health.check([
      () => this.database.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
