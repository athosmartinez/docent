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
 * The question's identity, independent of any corpus version — a hash of
 * the normalised text and nothing else. Shared by `answerKey` below (which
 * namespaces it under a version and an answering-configuration fingerprint)
 * and by anything that needs to identify a question without exposing its
 * text: a failure log line naming *which* question failed carries this
 * instead of the question itself, and it is the identical hash `answerKey`
 * uses, so the two are directly joinable — given a hash from a log line, a
 * known corpus version and the currently-running answering configuration,
 * `ans:<version>:<configFingerprint>:<hash>` is the exact key to check.
 */
export function questionHash(question: string): string {
  return sha256(normaliseQuestion(question));
}

/**
 * The subset of runtime configuration that changes what "the answer to this
 * question" means, independent of the corpus and the question text itself —
 * folded into `answerKey` the way `embeddingKey` already folds in its own
 * model/dimensionality. `llmChain` changes which model(s) can answer at
 * all; `groundingMaxDistance` changes whether a question is a refusal or an
 * answer — explicitly a knob `npm run calibrate:floor` re-derives, so
 * turning it must not silently keep serving what it replaced; and
 * `embeddingModel` changes what retrieval considers close enough, hence
 * both the grounding decision and which chunks get cited. Changing any of
 * these and restarting, without this fingerprint, would keep serving every
 * answer *and refusal* cached under the old configuration for up to
 * `CACHE_ANSWER_TTL_S` — the config appearing to do nothing.
 *
 * `RETRIEVAL_TOP_N`/`RETRIEVAL_TOP_K`/`RRF_K` also influence which chunks a
 * grounded answer cites and are a known, smaller residual gap this does not
 * yet close — see `_planning/03-roadmap.md`'s M3 debt.
 *
 * `EMBEDDING_DIMENSIONS` is deliberately absent: `env.schema.ts` refines it
 * to always equal `CHUNK_EMBEDDING_DIMENSIONS` at boot, so unlike
 * `embeddingKey`'s own dimensionality input it can never actually vary —
 * there is no configuration here to invalidate against.
 */
export interface AnsweringConfig {
  llmChain: string;
  groundingMaxDistance: number;
  embeddingModel: string;
}

export function answeringConfigFingerprint(config: AnsweringConfig): string {
  return sha256(
    `${config.llmChain}:${config.groundingMaxDistance}:${config.embeddingModel}`,
  );
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
 *
 * The caller is responsible for reading `version` once and reusing it for
 * both the cache lookup and the eventual write: retrieval and the
 * completion call both take real time, and a corpus change landing in that
 * window must not let the read and the write disagree about which version
 * the answer belongs to — the exact race that used to file a C1-grounded
 * answer under the key a newer, C2 corpus would compute (`AskService`'s
 * `cachedAnswer`/`writeCache` thread a single read through both call sites
 * for this reason).
 *
 * `configFingerprint` is `answeringConfigFingerprint`'s output, not the raw
 * config: `answerKey` only assembles identity from pieces its caller has
 * already reduced to strings, the same division of labour `embeddingKey`
 * keeps between itself and its own model/dimensionality inputs.
 */
export function answerKey(
  version: string,
  question: string,
  configFingerprint: string,
): string {
  return `ans:${version}:${configFingerprint}:${questionHash(question)}`;
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
