import { ConflictException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { describeError } from '../src/common/describe-error';
import { IngestionRepository } from '../src/ingestion/ingestion.repository';
import { IngestionService } from '../src/ingestion/ingestion.service';

function parseArguments(argv: string[]): { source: string; include: string } {
  const source = argv[0];

  if (source === undefined || source.startsWith('--')) {
    console.error('usage: npm run ingest -- <source> [--include <glob>]');
    process.exit(1);
  }

  const flagIndex = argv.indexOf('--include');
  const include = flagIndex === -1 ? '**/*.md' : argv[flagIndex + 1];

  if (include === undefined) {
    console.error('--include needs a value');
    process.exit(1);
  }

  return { source, include };
}

async function main(): Promise<void> {
  const { source, include } = parseArguments(process.argv.slice(2));

  // A standalone context gives the CLI the same wiring the HTTP app uses,
  // without starting a server.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const service = app.get(IngestionService);
    const repository = app.get(IngestionRepository);

    console.log(`ingesting ${source} (include: ${include})`);
    // ingestInline shares startIngestion's atomic claim, so a source another
    // run already holds is refused rather than raced. It runs the pipeline
    // inline and resolves only once ingestion is actually done: a CLI should
    // exit when the work is finished, not when it has been scheduled.
    const sourceId = await service.ingestInline(source, include);

    const result = await repository.findSource(sourceId);
    console.log(
      `done: ${String(result?.document_count)} documents, ${String(result?.chunk_count)} chunks`,
    );
  } catch (error) {
    if (error instanceof ConflictException) {
      console.error(`cannot start ingestion: ${describeError(error)}`);
    } else {
      console.error(`ingestion failed: ${describeError(error)}`);
    }
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
