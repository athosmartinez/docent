import { fuseByRrf } from './rrf';
import type { RankedChunk } from './retrieval.types';

const chunk = (id: string): RankedChunk => ({
  chunkId: id,
  documentPath: `docs/${id}.md`,
  headingPath: ['Heading'],
  content: `content of ${id}`,
});

describe('fuseByRrf', () => {
  it('ranks a chunk found by both arms above one found by either alone', () => {
    const vector = [chunk('a'), chunk('b')];
    const lexical = [chunk('c'), chunk('a')];

    const fused = fuseByRrf([vector, lexical], 60);

    expect(fused[0]?.chunkId).toBe('a');
  });

  it('returns the other list unchanged in order when one list is empty', () => {
    // The Portuguese-prose case: the lexical arm matches nothing, so the
    // sum has a single term and the result is the vector ranking.
    const vector = [chunk('a'), chunk('b'), chunk('c')];

    const fused = fuseByRrf([vector, []], 60);

    expect(fused.map((f) => f.chunkId)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array when every list is empty', () => {
    expect(fuseByRrf([[], []], 60)).toEqual([]);
  });

  it('keeps every chunk when the lists are disjoint', () => {
    const fused = fuseByRrf([[chunk('a')], [chunk('b')]], 60);

    expect(fused).toHaveLength(2);
  });

  it('emits each chunk once, however many arms found it', () => {
    const fused = fuseByRrf([[chunk('a')], [chunk('a')], [chunk('a')]], 60);

    expect(fused).toHaveLength(1);
  });

  it('scores by 1/(k + rank) with rank starting at 1', () => {
    const fused = fuseByRrf([[chunk('a')]], 60);

    expect(fused[0]?.score).toBeCloseTo(1 / 61, 10);
  });

  it('preserves the chunk payload of the first arm that reported it', () => {
    const fused = fuseByRrf([[chunk('a')], []], 60);

    expect(fused[0]?.documentPath).toBe('docs/a.md');
    expect(fused[0]?.headingPath).toEqual(['Heading']);
    expect(fused[0]?.content).toBe('content of a');
  });
});
