import { RetrievalService } from './retrieval.service';
import type { RetrievalRepository } from './retrieval.repository';
import type { EmbeddingsProvider } from '../embeddings/embeddings.types';
import type { RankedChunk, VectorRankedChunk } from './retrieval.types';

const chunk = (id: string): RankedChunk => ({
  chunkId: id,
  documentPath: `docs/${id}.md`,
  headingPath: [],
  content: id,
});

const vectorChunk = (id: string, distance: number): VectorRankedChunk => ({
  ...chunk(id),
  distance,
});

const embeddings: EmbeddingsProvider = {
  embed: (texts) => Promise.resolve(texts.map(() => [0.1, 0.2])),
};

function serviceWith(
  vectorResult: VectorRankedChunk[],
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
    const { service } = serviceWith([vectorChunk('a', 0.1)], [chunk('b')]);

    const { chunks } = await service.search('question');

    expect(chunks.map((r) => r.chunkId).sort()).toEqual(['a', 'b']);
  });

  it('truncates to topK', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => vectorChunk(id, 0.1));
    const { service } = serviceWith(many, [], 2);

    const { chunks } = await service.search('question');

    expect(chunks).toHaveLength(2);
  });

  it('returns the vector ranking when the lexical arm matches nothing', async () => {
    const { service } = serviceWith(
      [vectorChunk('a', 0.1), vectorChunk('b', 0.2)],
      [],
    );

    const { chunks } = await service.search('pergunta em portugues');

    expect(chunks.map((r) => r.chunkId)).toEqual(['a', 'b']);
  });

  it('returns nothing when both arms are empty', async () => {
    const { service } = serviceWith([], []);

    const { chunks } = await service.search('question');

    expect(chunks).toEqual([]);
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

  it("reports the vector arm's first result's distance as bestDistance", async () => {
    const { service } = serviceWith([vectorChunk('a', 0.42)], [chunk('b')]);

    const { bestDistance } = await service.search('question');

    expect(bestDistance).toBe(0.42);
  });

  it('reports bestDistance as null when the vector arm returns nothing', async () => {
    const { service } = serviceWith([], [chunk('a')]);

    const { bestDistance } = await service.search('question');

    expect(bestDistance).toBeNull();
  });

  it("keeps bestDistance tied to the vector arm's ranking even when fusion reorders the result", async () => {
    // 'a' is the vector arm's nearest chunk (rank 1) but only appears in that
    // arm, so its RRF score (1/61) loses to 'b', which ranks lower in the
    // vector arm (rank 2, 1/62) but also ranks first in the lexical arm
    // (1/61), summing to 1/62 + 1/61. Fusion puts 'b' first; bestDistance
    // must still come from 'a', because it is the vector arm's rank 1.
    const { service } = serviceWith(
      [vectorChunk('a', 0.1), vectorChunk('b', 0.9)],
      [chunk('b')],
    );

    const { chunks, bestDistance } = await service.search('question');

    expect(chunks[0]?.chunkId).toBe('b');
    expect(bestDistance).toBe(0.1);
  });
});
