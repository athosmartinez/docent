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
