import { RetrievalService } from './retrieval.service';
import type { RetrievalRepository } from './retrieval.repository';
import type { EmbeddingsProvider } from '../embeddings/embeddings.types';
import type { RankedChunk } from './retrieval.types';

const chunk = (id: string): RankedChunk => ({
  chunkId: id,
  documentPath: `docs/${id}.md`,
  headingPath: [],
  content: id,
});

const embeddings: EmbeddingsProvider = {
  embed: (texts) => Promise.resolve(texts.map(() => [0.1, 0.2])),
};

function serviceWith(
  vectorResult: RankedChunk[],
  lexicalResult: RankedChunk[],
  topK = 8,
): { service: RetrievalService; repository: RetrievalRepository } {
  const repository = {
    searchByVector: jest.fn().mockResolvedValue(vectorResult),
    searchByText: jest.fn().mockResolvedValue(lexicalResult),
  } as unknown as RetrievalRepository;

  return {
    service: new RetrievalService(repository, embeddings, 20, topK, 60),
    repository,
  };
}

describe('RetrievalService', () => {
  it('embeds the question exactly once', async () => {
    const embed = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    const repository = {
      searchByVector: jest.fn().mockResolvedValue([]),
      searchByText: jest.fn().mockResolvedValue([]),
    } as unknown as RetrievalRepository;

    const service = new RetrievalService(repository, { embed }, 20, 8, 60);

    await service.search('question');

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(['question']);
  });

  it('fuses both arms', async () => {
    const { service } = serviceWith([chunk('a')], [chunk('b')]);

    const results = await service.search('question');

    expect(results.map((r) => r.chunkId).sort()).toEqual(['a', 'b']);
  });

  it('truncates to topK', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map(chunk);
    const { service } = serviceWith(many, [], 2);

    const results = await service.search('question');

    expect(results).toHaveLength(2);
  });

  it('returns the vector ranking when the lexical arm matches nothing', async () => {
    const { service } = serviceWith([chunk('a'), chunk('b')], []);

    const results = await service.search('pergunta em portugues');

    expect(results.map((r) => r.chunkId)).toEqual(['a', 'b']);
  });

  it('returns nothing when both arms are empty', async () => {
    const { service } = serviceWith([], []);

    expect(await service.search('question')).toEqual([]);
  });

  it('throws when the embeddings provider returns no vector', async () => {
    const repository = {
      searchByVector: jest.fn(),
      searchByText: jest.fn(),
    } as unknown as RetrievalRepository;

    const service = new RetrievalService(
      repository,
      { embed: () => Promise.resolve([]) },
      20,
      8,
      60,
    );

    await expect(service.search('question')).rejects.toThrow(/no embedding/i);
  });
});
