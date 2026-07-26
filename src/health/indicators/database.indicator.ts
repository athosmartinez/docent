import { Inject, Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { Kysely, sql } from 'kysely';

import { KYSELY } from '../../common/database/database.module';
import type { DB } from '../../common/database/schema';
import { withTimeout } from '../../common/with-timeout';

const PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await withTimeout(sql`select 1`.execute(this.db), PROBE_TIMEOUT_MS);
      return indicator.up();
    } catch (error) {
      return indicator.down(
        error instanceof Error ? error.message : 'unreachable',
      );
    }
  }
}
