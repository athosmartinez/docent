/* eslint-disable @typescript-eslint/no-explicit-any, no-console */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const direction = process.argv[2] === 'down' ? 'down' : 'latest';

  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
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
    const outcome = result.status === 'Success' ? 'applied' : result.status;
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
