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
 * Namespaced under the corpus version an answer was produced against —
 * carried in the key itself, not hashed away — so adding or removing a
 * ready source always invalidates every cached answer at once, by changing
 * the key every one of them was stored under: CorpusVersion's count term
 * moves unconditionally either way. Re-ingesting an existing source
 * invalidates them too only when its refreshed timestamp becomes the newest
 * among ready sources — the common case, but not guaranteed if another
 * ready source already carries a later one. In that case the version
 * string, and so the key, is unchanged, and the pre-re-ingest entry is
 * served again until CACHE_ANSWER_TTL_S expires it — this key scheme
 * invalidates by making a changed corpus compute a different key, not by
 * guaranteeing every change does. Nothing has to walk Redis and delete
 * anything for the cases it does cover.
 */
export function answerKey(version: string, question: string): string {
  return `ans:${version}:${sha256(normaliseQuestion(question))}`;
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
