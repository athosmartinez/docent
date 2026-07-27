import { Inject, Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { Kysely, sql } from 'kysely';

import { KYSELY } from '../../common/database/database.module';
import type { DB } from '../../common/database/schema';
import { describeError } from '../../common/describe-error';
import { withTimeout } from '../../common/with-timeout';

const PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class DatabaseHealthIndicator {
  // See IngestionService's constructor for why the second parameter is
  // explicitly @Inject()-ed instead of left to implicit type-based
  // resolution.
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    @Inject(HealthIndicatorService)
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await withTimeout(sql`select 1`.execute(this.db), PROBE_TIMEOUT_MS);
      return indicator.up();
    } catch (error) {
      return indicator.down(describeError(error));
    }
  }
}
