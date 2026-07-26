import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import { describeError } from '../describe-error';
import { withTimeout } from '../with-timeout';
import type { Env } from '../config/env.schema';
import type { DB } from './schema';

export const KYSELY = Symbol('KYSELY');

// Kysely.destroy() -> pool.end() waits for every checked-out client to be
// released. A client stuck mid-query against a frozen dependency never
// releases, which would otherwise hang shutdown indefinitely; bounding it
// lets the process exit on schedule instead.
const SHUTDOWN_TIMEOUT_MS = 3_000;

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Kysely<DB> => {
        const pool = new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
        });

        // A client that goes idle in the pool after a successful query still
        // holds an open socket. If Postgres disappears out from under it, that
        // socket errors outside of any query, and pg-pool re-emits it as
        // 'error' on the bare Pool. An EventEmitter with no listener for
        // 'error' throws, which would take the process down in exactly the
        // situation the health check exists to report.
        const logger = new Logger('Database');
        pool.on('error', (error: unknown) => logger.warn(describeError(error)));

        return new Kysely<DB>({
          dialect: new PostgresDialect({ pool }),
        });
      },
    },
  ],
  exports: [KYSELY],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger('Database');

  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await withTimeout(this.db.destroy(), SHUTDOWN_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(
        `pool did not close within ${SHUTDOWN_TIMEOUT_MS}ms: ${describeError(error)}`,
      );
    }
  }
}
