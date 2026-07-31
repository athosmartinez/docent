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
    const chunks = [chunk('a', 0.9), chunk('b', 0.8)];
    const { user } = buildPrompt('how?', chunks);
    const citations = toCitations(chunks);

    // The contract that makes a citation resolvable: source [2] in the
    // prompt and citations[1] must be the same chunk.
    expect(user).toContain('[2] content/b.md');
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
