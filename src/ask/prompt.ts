import type { CompletionRequest } from '../llm/llm.types';
import type { RetrievedChunk } from '../retrieval/retrieval.types';
import type { Citation } from './ask.types';

const SYSTEM = [
  'You answer questions about a documentation corpus.',
  '',
  'Answer only from the numbered sources given to you. Never use knowledge',
  'from outside them, and never invent an API, an option or a file name that',
  'the sources do not contain.',
  '',
  'Cite inline with the source number in square brackets, like [1] or [2],',
  'immediately after the claim it supports. Cite every claim.',
  '',
  'If the sources do not answer the question, say so plainly instead of',
  'assembling a plausible answer.',
  '',
  'Answer in the same language as the question, even though the sources are',
  'in English.',
].join('\n');

/**
 * The numbering is 1-based and shared with toCitations, so a `[2]` the model
 * writes resolves to the second entry of the citations array. Both derive it
 * from the same array order rather than each computing its own.
 */
export function toCitations(chunks: RetrievedChunk[]): Citation[] {
  return chunks.map((chunk, index) => ({
    ordinal: index + 1,
    chunkId: chunk.chunkId,
    path: chunk.documentPath,
    headingPath: chunk.headingPath,
    score: chunk.score,
  }));
}

export function buildPrompt(
  question: string,
  chunks: RetrievedChunk[],
): CompletionRequest {
  const sources = chunks
    .map((chunk, index) => {
      const heading = chunk.headingPath.join(' > ');
      const label = heading
        ? `${chunk.documentPath} — ${heading}`
        : chunk.documentPath;

      return `[${index + 1}] ${label}\n${chunk.content}`;
    })
    .join('\n\n---\n\n');

  return {
    system: SYSTEM,
    user: `Sources:\n\n${sources}\n\n---\n\nQuestion: ${question}`,
  };
}
