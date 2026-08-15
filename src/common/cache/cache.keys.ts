import { createHash } from 'node:crypto';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Collapses incidental whitespace differences so two questions that read the
 * same to a person hash to the same key. Case is left alone on purpose: the
 * retriever ranks differently-cased text differently, so lowercasing here
 * would merge cache entries the rest of the system treats as distinct
 * questions.
 */
export function normaliseQuestion(question: string): string {
  return question.trim().replace(/\s+/g, ' ');
}

/**
 * Model and dimensionality are baked into the key, so switching either
 * produces a different key rather than a hit against a vector computed
 * under the old settings — an entry can never be stale, by construction.
 * The TTL on the write side exists only to bound how much memory the cache
 * holds; it has nothing to do with keeping entries correct.
 */
export function embeddingKey(
  model: string,
  dimensions: number,
  question: string,
): string {
  return `emb:${sha256(`${model}:${dimensions}:${normaliseQuestion(question)}`)}`;
}

/**
 * pgvector stores a `vector` column as 4-byte floats, so narrowing to
 * Float32Array before encoding discards only precision the database would
 * have discarded on write anyway — this is not a space/accuracy trade-off,
 * the accuracy was never there to keep. The base64 form is also roughly a
 * third the size of the equivalent JSON array, which is what actually earns
 * its keep against Redis memory.
 */
export function encodeVector(vector: number[]): string {
  const floats = Float32Array.from(vector);
  return Buffer.from(
    floats.buffer,
    floats.byteOffset,
    floats.byteLength,
  ).toString('base64');
}

export function decodeVector(encoded: string): number[] {
  const buffer = Buffer.from(encoded, 'base64');
  return Array.from(
    new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4),
  );
}
