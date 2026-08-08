import type { RankedChunk, RetrievedChunk } from './retrieval.types';

/**
 * Reciprocal Rank Fusion: score(chunk) = Σ 1 / (k + rank).
 *
 * It reads positions and never the arms' own scores, which is what makes it
 * usable here at all — ts_rank values measured against this corpus sit around
 * 0.015–0.07 while cosine distance lives on an unrelated scale, and any
 * normalisation into a weighted sum would need a min and max that depend on
 * both the corpus and the question.
 *
 * The empty-list case is load-bearing rather than defensive: a question in a
 * language the corpus is not written in matches no lexemes, so the lexical arm
 * returns nothing, the sum keeps a single term, and the result is exactly the
 * vector ranking. That is the intended behaviour, reached without a branch.
 */
export function fuseByRrf(
  lists: RankedChunk[][],
  rrfK: number,
): RetrievedChunk[] {
  const scores = new Map<string, number>();
  const payloads = new Map<string, RankedChunk>();

  for (const list of lists) {
    for (const [index, chunk] of list.entries()) {
      const rank = index + 1;
      const previous = scores.get(chunk.chunkId) ?? 0;

      scores.set(chunk.chunkId, previous + 1 / (rrfK + rank));

      if (!payloads.has(chunk.chunkId)) {
        payloads.set(chunk.chunkId, chunk);
      }
    }
  }

  const fused: RetrievedChunk[] = [];

  for (const [chunkId, score] of scores) {
    const payload = payloads.get(chunkId);

    if (payload) {
      fused.push({ ...payload, score });
    }
  }

  return fused.sort((a, b) => b.score - a.score);
}
