import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';

import { describeError } from '../src/common/describe-error';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const direction = process.argv[2] === 'down' ? 'down' : 'latest';

  const pool = new Pool({ connectionString });

  // Same exposure as the app's own pool: a client that goes idle after a
  // successful query still holds an open socket, and an EventEmitter with no
  // listener for 'error' throws and kills this short-lived process.
  pool.on('error', (error: unknown) => console.error(describeError(error)));

  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(process.cwd(), 'migrations'),
    }),
  });

  const { error, results } =
    direction === 'down'
      ? await migrator.migrateDown()
      : await migrator.migrateToLatest();

  for (const result of results ?? []) {
    const outcome =
      result.status === 'Success'
        ? direction === 'down'
          ? 'reverted'
          : 'applied'
        : result.status;
    console.log(`${outcome}: ${result.migrationName}`);
  }

  await db.destroy();

  if (error) {
    console.error('migration failed:', error);
    process.exit(1);
  }

  if (!results?.length) {
    console.log('no pending migrations');
  }
}

void main();
