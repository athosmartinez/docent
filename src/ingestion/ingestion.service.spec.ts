import { ConflictException } from '@nestjs/common';

import type { EmbeddingsProvider } from '../embeddings/embeddings.types';
import { IngestionService } from './ingestion.service';
import type { IngestionRepository, SourceRow } from './ingestion.repository';

function readySource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 'source-1',
    uri: 'test://uri',
    type: 'docs',
    status: 'ready',
    error: null,
    commit_sha: null,
    document_count: 1,
    chunk_count: 4,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const noopEmbeddings: EmbeddingsProvider = {
  embed: () => Promise.resolve([]),
};

describe('IngestionService reuse ordering', () => {
  it('claims the source — moving it off its terminal status — before clearing its content', async () => {
    // A recording fake driven through the real startIngestion, rather than
    // a hand-written replica of its call sequence: this is what makes the
    // test fail if the service's own ordering regresses, not just if the
    // repository's individual methods stop being safe to call in sequence.
    const calls: string[] = [];
    const source = readySource();

    const repository: Partial<IngestionRepository> = {
      findSourceByUri: () => Promise.resolve(source),
      databaseNow: () => Promise.resolve(new Date()),
      claimForProcessing: () => {
        calls.push('claimForProcessing');

        return Promise.resolve({ ...source, status: 'processing' });
      },
      deleteSourceContent: () => {
        calls.push('deleteSourceContent');

        return Promise.resolve();
      },
    };

    const service = new IngestionService(
      repository as IngestionRepository,
      noopEmbeddings,
    );

    // startIngestion fires runPipeline without awaiting it; stubbing it here
    // keeps this test scoped to the ordering startIngestion itself performs.
    jest.spyOn(service, 'runPipeline').mockResolvedValue(undefined);

    await service.startIngestion('test://uri', '**/*.md');

    expect(calls).toEqual(['claimForProcessing', 'deleteSourceContent']);
  });
});

describe('IngestionService.ingestInline', () => {
  it('claims the source and awaits the pipeline before resolving, unlike startIngestion', async () => {
    // The CLI's whole reason to call ingestInline instead of startIngestion
    // is to block until the work is done — this asserts runPipeline has
    // actually settled by the time ingestInline's own promise resolves,
    // not merely been scheduled.
    const calls: string[] = [];
    const source = readySource();

    const repository: Partial<IngestionRepository> = {
      findSourceByUri: () => Promise.resolve(source),
      databaseNow: () => Promise.resolve(new Date()),
      claimForProcessing: () => {
        calls.push('claimForProcessing');

        return Promise.resolve({ ...source, status: 'processing' });
      },
      deleteSourceContent: () => {
        calls.push('deleteSourceContent');

        return Promise.resolve();
      },
    };

    const service = new IngestionService(
      repository as IngestionRepository,
      noopEmbeddings,
    );

    jest.spyOn(service, 'runPipeline').mockImplementation(async () => {
      calls.push('runPipeline');
      await Promise.resolve();
    });

    const sourceId = await service.ingestInline('test://uri', '**/*.md');

    expect(sourceId).toBe(source.id);
    expect(calls).toEqual([
      'claimForProcessing',
      'deleteSourceContent',
      'runPipeline',
    ]);
  });

  it('rejects with the same ConflictException as startIngestion when another run already holds the source', async () => {
    // A CLI run racing a live HTTP ingestion for the same source must lose
    // the same way a second HTTP request would — not wait, not force.
    const source = readySource({ status: 'processing' });

    const repository: Partial<IngestionRepository> = {
      findSourceByUri: () => Promise.resolve(source),
      databaseNow: () => Promise.resolve(new Date()),
      claimForProcessing: () => Promise.resolve(undefined),
    };

    const service = new IngestionService(
      repository as IngestionRepository,
      noopEmbeddings,
    );

    await expect(
      service.ingestInline('test://uri', '**/*.md'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
