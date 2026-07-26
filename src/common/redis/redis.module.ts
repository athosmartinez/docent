import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { describeError } from '../describe-error';
import { withTimeout } from '../with-timeout';
import type { Env } from '../config/env.schema';

export const REDIS = Symbol('REDIS');

// quit() waits for Redis to reply to the QUIT command. Against a frozen
// dependency that reply never comes, which would otherwise hang shutdown
// indefinitely; bounding it lets the process exit on schedule instead.
const SHUTDOWN_TIMEOUT_MS = 3_000;

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Redis => {
        const client = new Redis(config.get('REDIS_URL', { infer: true }), {
          maxRetriesPerRequest: 1,
        });

        // ioredis emits 'error' on every reconnection attempt. An EventEmitter
        // with no listener for that event throws, which would take the process
        // down in exactly the situation the health check exists to report.
        const logger = new Logger('Redis');
        client.on('error', (error: unknown) =>
          logger.warn(describeError(error)),
        );

        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await withTimeout(this.client.quit(), SHUTDOWN_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(
        `client did not close within ${SHUTDOWN_TIMEOUT_MS}ms: ${describeError(error)}`,
      );
    }
  }
}
