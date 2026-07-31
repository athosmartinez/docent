import { buildPrompt, toCitations } from './prompt';
import type { RetrievedChunk } from '../retrieval/retrieval.types';

const chunk = (id: string, score: number): RetrievedChunk => ({
  chunkId: id,
  documentPath: `content/${id}.md`,
  headingPath: ['Techniques', id],
  content: `body of ${id}`,
  score,
});

describe('toCitations', () => {
  it('numbers citations from 1 in retrieval order', () => {
    const citations = toCitations([chunk('a', 0.9), chunk('b', 0.8)]);

    expect(citations.map((c) => c.ordinal)).toEqual([1, 2]);
    expect(citations.map((c) => c.chunkId)).toEqual(['a', 'b']);
  });

  it('carries path, heading path and score through', () => {
    const [citation] = toCitations([chunk('a', 0.9)]);

    expect(citation?.path).toBe('content/a.md');
    expect(citation?.headingPath).toEqual(['Techniques', 'a']);
    expect(citation?.score).toBeCloseTo(0.9);
  });

  it('returns an empty array for no chunks', () => {
    expect(toCitations([])).toEqual([]);
  });
});

describe('buildPrompt', () => {
  it('numbers the sources the same way toCitations does', () => {
    // Retrieval order (a, b) is deliberately the reverse of score order
    // (b's score is higher). If either function quietly re-derived its
    // numbering from score instead of array order, the two would disagree
    // here — with same-order scores that drift would be invisible.
    const chunks = [chunk('a', 0.3), chunk('b', 0.9)];
    const { user } = buildPrompt('how?', chunks);
    const citations = toCitations(chunks);

    // The contract that makes a citation resolvable: source [N] in the
    // prompt and citations[N-1] must be the same chunk, at both ends.
    expect(user).toContain('[1] content/a.md');
    expect(user).toContain('[2] content/b.md');
    expect(citations[0]?.chunkId).toBe('a');
    expect(citations[1]?.chunkId).toBe('b');
  });

  it('includes each chunk body', () => {
    const { user } = buildPrompt('how?', [chunk('a', 0.9)]);

    expect(user).toContain('body of a');
  });

  it('includes the heading path so the model can name the section', () => {
    const { user } = buildPrompt('how?', [chunk('a', 0.9)]);

    expect(user).toContain('Techniques > a');
  });

  it('omits the separator when a chunk has no heading path', () => {
    const rootChunk: RetrievedChunk = { ...chunk('a', 0.9), headingPath: [] };
    const { user } = buildPrompt('how?', [rootChunk]);

    expect(user).toContain('[1] content/a.md\nbody of a');
    expect(user).not.toContain('—');
  });

  it('includes the question', () => {
    const { user } = buildPrompt('how do I validate?', [chunk('a', 0.9)]);

    expect(user).toContain('how do I validate?');
  });

  it('instructs the model to answer only from the sources', () => {
    const { system } = buildPrompt('how?', [chunk('a', 0.9)]);

    expect(system.toLowerCase()).toContain('only');
  });

  it('instructs the model to answer in the language of the question', () => {
    const { system } = buildPrompt('how?', [chunk('a', 0.9)]);

    expect(system.toLowerCase()).toContain('language');
  });
});
