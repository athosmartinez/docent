import type Redis from 'ioredis';

import { RetrievalService } from './retrieval.service';
import type { RetrievalRepository } from './retrieval.repository';
import { CacheService } from '../common/cache/cache.service';
import { embeddingKey } from '../common/cache/cache.keys';
import type { EmbeddingsProvider } from '../embeddings/embeddings.types';
import type { RankedChunk, VectorRankedChunk } from './retrieval.types';

const MODEL = 'text-embedding-3-large';
const DIMENSIONS = 3072;
const CACHE_TTL_S = 2_592_000;

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

function noopCache(): CacheService {
  return {
    getVector: jest.fn().mockResolvedValue(null),
    setVector: jest.fn().mockResolvedValue(undefined),
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
}

function serviceWith(
  vectorResult: VectorRankedChunk[],
  lexicalResult: RankedChunk[],
  topK = 8,
  cache: CacheService = noopCache(),
): { service: RetrievalService; repository: RetrievalRepository } {
  const repository = {
    searchByVector: jest.fn().mockResolvedValue(vectorResult),
    searchByText: jest.fn().mockResolvedValue(lexicalResult),
  } as unknown as RetrievalRepository;

  return {
    service: new RetrievalService(
      repository,
      embeddings,
      cache,
      20,
      topK,
      60,
      MODEL,
      DIMENSIONS,
      CACHE_TTL_S,
    ),
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

    const service = new RetrievalService(
      repository,
      { embed },
      noopCache(),
      20,
      8,
      60,
      MODEL,
      DIMENSIONS,
      CACHE_TTL_S,
    );

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
      noopCache(),
      20,
      8,
      60,
      MODEL,
      DIMENSIONS,
      CACHE_TTL_S,
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

  describe('embedding cache', () => {
    it('does not call embed on a cache hit, and uses the cached vector', async () => {
      const embed = jest.fn().mockResolvedValue([[9, 9]]);
      const searchByVector = jest.fn().mockResolvedValue([]);
      const repository = {
        searchByVector,
        searchByText: jest.fn().mockResolvedValue([]),
      } as unknown as RetrievalRepository;
      const cachedVector = [0.5, 0.25];
      const getVector = jest.fn().mockResolvedValue(cachedVector);
      const cache = {
        getVector,
        setVector: jest.fn().mockResolvedValue(undefined),
      } as unknown as CacheService;

      const service = new RetrievalService(
        repository,
        { embed },
        cache,
        20,
        8,
        60,
        MODEL,
        DIMENSIONS,
        CACHE_TTL_S,
      );

      await service.search('question');

      expect(embed).not.toHaveBeenCalled();
      expect(searchByVector).toHaveBeenCalledWith(cachedVector, 20);
    });

    it('reads and writes under the same key the codec would derive', async () => {
      const getVector = jest.fn().mockResolvedValue(null);
      const setVector = jest.fn().mockResolvedValue(undefined);
      const cache = { getVector, setVector } as unknown as CacheService;
      const { service } = serviceWith([], [], 8, cache);

      await service.search('what does ValidationPipe do?');

      const expectedKey = embeddingKey(
        MODEL,
        DIMENSIONS,
        'what does ValidationPipe do?',
      );
      expect(getVector).toHaveBeenCalledWith(expectedKey);
      expect(setVector).toHaveBeenCalledWith(
        expectedKey,
        [0.1, 0.2],
        CACHE_TTL_S,
      );
    });

    it('calls embed exactly once on a miss and writes the result to the cache', async () => {
      const embed = jest.fn().mockResolvedValue([[0.7, 0.8]]);
      const repository = {
        searchByVector: jest.fn().mockResolvedValue([]),
        searchByText: jest.fn().mockResolvedValue([]),
      } as unknown as RetrievalRepository;
      const setVector = jest.fn().mockResolvedValue(undefined);
      const cache = {
        getVector: jest.fn().mockResolvedValue(null),
        setVector,
      } as unknown as CacheService;

      const service = new RetrievalService(
        repository,
        { embed },
        cache,
        20,
        8,
        60,
        MODEL,
        DIMENSIONS,
        CACHE_TTL_S,
      );

      await service.search('question');

      expect(embed).toHaveBeenCalledTimes(1);
      expect(setVector).toHaveBeenCalledTimes(1);
      expect(setVector).toHaveBeenCalledWith(
        expect.any(String),
        [0.7, 0.8],
        CACHE_TTL_S,
      );
    });

    // Exercises the real CacheService against a Redis double whose read
    // rejects, rather than a hand-rolled cache mock: the unit that actually
    // needs to hold is the composition of the two, not just CacheService's
    // own fail-open in isolation (which its own suite already covers).
    it('still produces an answer when the cache backing store is unreachable', async () => {
      const failingRedis = {
        get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const cache = new CacheService(failingRedis as unknown as Redis);

      const { service } = serviceWith(
        [vectorChunk('a', 0.1)],
        [chunk('b')],
        8,
        cache,
      );

      const { chunks } = await service.search('question');

      expect(chunks.map((r) => r.chunkId).sort()).toEqual(['a', 'b']);
    });
  });
});
