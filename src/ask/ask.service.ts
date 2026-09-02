import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  answerKey,
  answeringConfigFingerprint,
} from '../common/cache/cache.keys';
import { CacheService } from '../common/cache/cache.service';
import { CorpusVersion } from '../common/cache/corpus-version';
import { describeError } from '../common/describe-error';
import { computeCost } from '../cost/cost.calculator';
import {
  LLM,
  type LlmProvider,
  type StreamOutcome,
  type TokenUsage,
} from '../llm/llm.types';
import { RetrievalService } from '../retrieval/retrieval.service';
import type { RetrievedChunk } from '../retrieval/retrieval.types';
import {
  AskRepository,
  type RecordCost,
  type RecordInput,
} from './ask.repository';
import type { AskResult, CachedAnswer } from './ask.types';
import { buildPrompt, toCitations } from './prompt';

/** Postgres' error code for a foreign-key violation. */
const FOREIGN_KEY_VIOLATION_CODE = '23503';

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === FOREIGN_KEY_VIOLATION_CODE
  );
}

/**
 * What `cachedAnswer` reads once, at the start of a request, and every
 * caller threads through to whichever write follows — `writeCache` via
 * `recordStreamed`/`recordRefusal`'s own `version` parameter, or `ask`'s
 * inline write on a miss. Carrying the same value forward rather than
 * letting the write re-read it is what keeps the read and the write from
 * ever disagreeing about which corpus the answer belongs to; see
 * `writeCache`'s own docstring for what disagreeing used to cost.
 */
export interface CachedLookup {
  version: string;
  cached: CachedAnswer | null;
}

@Injectable()
export class AskService {
  private readonly logger = new Logger(AskService.name);
  private readonly answeringConfigFingerprint: string;

  constructor(
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(LLM) private readonly llm: LlmProvider,
    @Inject(AskRepository) private readonly repository: AskRepository,
    @Inject('GROUNDING_MAX_DISTANCE') private readonly maxDistance: number,
    @Inject(CacheService) private readonly cache: CacheService,
    @Inject(CorpusVersion) private readonly corpusVersion: CorpusVersion,
    @Inject('CACHE_ANSWER_TTL_S') private readonly answerCacheTtlS: number,
    @Inject('LLM_CHAIN') llmChain: string,
    @Inject('EMBEDDING_MODEL') embeddingModel: string,
  ) {
    // Computed once at construction, not per request: every input is a
    // boot-time configuration value read through DI, none of which changes
    // for the life of this process.
    this.answeringConfigFingerprint = answeringConfigFingerprint({
      llmChain,
      groundingMaxDistance: maxDistance,
      embeddingModel,
    });
  }

  /**
   * Retrieval decides whether an answer is possible, before any token is
   * spent. A nearest chunk further than the threshold means no LLM call at
   * all — a model asked to rate its own grounding reports high confidence on
   * hallucinations, so the signal has to come from outside it. Distance is a
   * cost, not a score, so the comparison is against an upper bound: the
   * question is grounded when the nearest chunk is *within* the threshold.
   *
   * Written as that positive condition rather than as its negation
   * (`bestDistance > this.maxDistance` ⇒ refuse) on purpose: every
   * comparison against NaN is false, so the negated form silently falls
   * through to "grounded" on a NaN distance, however low the threshold is
   * set — including -Infinity, which exists specifically to force a refusal
   * on every question. pgvector's cosine distance (`<=>`) returns NaN for a
   * zero-norm query vector, measured directly against this corpus; written
   * as "accept when within bound", the same false comparison instead makes
   * `isGrounded` false, so NaN refuses like any other unmeasurable distance.
   */
  async retrieveGrounded(question: string): Promise<RetrievedChunk[] | null> {
    const { chunks, bestDistance } = await this.retrieval.search(question);

    const isGrounded =
      bestDistance !== null && bestDistance <= this.maxDistance;

    return isGrounded ? chunks : null;
  }

  async ask(question: string): Promise<AskResult> {
    const { version, cached } = await this.cachedAnswer(question);

    if (cached) {
      await this.recordCacheHit(question, cached);
      return {
        answer: cached.answer,
        grounded: cached.grounded,
        citations: cached.citations,
      };
    }

    const chunks = await this.retrieveGrounded(question);

    if (!chunks) {
      await this.recordRefusal(question, version);
      return { answer: null, grounded: false, citations: [] };
    }

    const citations = toCitations(chunks);
    const completion = await this.llm.complete(buildPrompt(question, chunks));

    await this.persist({
      question,
      answer: this.storedAnswer(completion.text),
      grounded: true,
      model: completion.model,
      provider: completion.provider,
      finishReason: completion.finishReason,
      citations,
      cost: this.buildCost(completion),
    });

    await this.writeCache(question, version, {
      answer: completion.text,
      grounded: true,
      citations,
      provider: completion.provider,
      model: completion.model,
      finishReason: completion.finishReason,
    });

    // The client gets exactly what the provider returned, empty string
    // included — the null-conversion below is about what gets stored, not
    // what goes out over the wire.
    return { answer: completion.text, grounded: true, citations };
  }

  /**
   * Reads a cached answer for the question as it stands against the corpus
   * right now, and returns the corpus version that lookup was made against
   * alongside it — the version the caller must reuse for whatever write
   * follows a miss, rather than asking `corpusVersion` again later. A miss
   * and a hit against a version nothing derives any more (a stale entry
   * outlived by a corpus change, still sitting under its old key until its
   * TTL expires) are indistinguishable here by construction — both simply
   * fail to match the key this call looks up, which is exactly what makes
   * the corpus version doing the invalidating rather than a delete
   * sufficient.
   */
  async cachedAnswer(question: string): Promise<CachedLookup> {
    const version = await this.corpusVersion.current();
    const cached = await this.cache.getJson<CachedAnswer>(
      answerKey(version, question, this.answeringConfigFingerprint),
    );
    return { version, cached };
  }

  /**
   * Records a cache hit as though it were a freshly produced answer: the
   * eval suite reads `queries`, and a hit that left no trace would make
   * repeated traffic vanish from that record. Shared by the JSON and SSE hit
   * paths so a hit cannot be recorded differently depending on which
   * endpoint served it.
   */
  async recordCacheHit(question: string, cached: CachedAnswer): Promise<void> {
    await this.persist({
      question,
      answer: cached.answer === null ? null : this.storedAnswer(cached.answer),
      grounded: cached.grounded,
      model: cached.model,
      provider: cached.provider,
      finishReason: cached.finishReason,
      citations: cached.citations,
      cost: this.cachedCost(cached),
    });
  }

  /**
   * The streaming path cannot reuse `ask`: the text only exists once the last
   * delta has been sent, and which model actually answered is only known
   * from the router's outcome, readable only after the stream has ended.
   * Recording it afterwards keeps a streamed answer in the same tables as a
   * non-streamed one, which is what lets the evaluation suite read both back
   * the same way.
   *
   * `version` is the corpus version the controller already read from
   * `cachedAnswer` before retrieval ran — required, not re-derived here, for
   * the same reason `ask`'s own write threads it through: see `writeCache`.
   */
  async recordStreamed(
    question: string,
    chunks: RetrievedChunk[],
    text: string,
    outcome: StreamOutcome,
    version: string,
  ): Promise<void> {
    const citations = toCitations(chunks);

    await this.persist({
      question,
      answer: this.storedAnswer(text),
      grounded: true,
      model: outcome.model,
      provider: outcome.provider,
      finishReason: outcome.finishReason,
      citations,
      cost: this.buildCost(outcome),
    });

    await this.writeCache(question, version, {
      answer: text,
      grounded: true,
      citations,
      provider: outcome.provider,
      model: outcome.model,
      finishReason: outcome.finishReason,
    });
  }

  /**
   * `version` is the corpus version the caller already read from
   * `cachedAnswer` — the streaming controller's refusal branch reads it once
   * before deciding there are no chunks to ground on, and passes the same
   * value here rather than this method asking again.
   */
  async recordRefusal(question: string, version: string): Promise<void> {
    await this.persist({
      question,
      answer: null,
      grounded: false,
      model: null,
      provider: null,
      finishReason: null,
      citations: [],
    });

    // A refusal is cached too — this is where the biggest saving is, since
    // an uncached refusal still pays for an embedding and the retrieval
    // query before giving up.
    await this.writeCache(question, version, {
      answer: null,
      grounded: false,
      citations: [],
      provider: null,
      model: null,
      finishReason: null,
    });
  }

  /**
   * Writes the answer under the corpus version its caller already read at
   * the top of the request — via `cachedAnswer` — rather than reading it
   * again here. Re-reading at write time was the original design, and it
   * was wrong: retrieval and the completion call both take real time, and a
   * source reaching `ready` during that window made this second read return
   * a version newer than the one the answer was actually grounded in — a
   * C1-grounded answer filed under `ans:<C2 version>:...`, the exact key
   * the *new* corpus computes, served back as though it were a fresh,
   * correct C2 answer the moment C2 genuinely became current. Threading a
   * single read through both call sites closes that: the key an answer is
   * stored under now always reflects the corpus exactly as it stood when
   * the read at the top of the request happened, which is the corpus
   * retrieval and the completion actually ran against.
   *
   * `cache.setJson` is documented to fail open on its own (see
   * `CacheService`), so this try/catch no longer guards a live database call
   * the way it used to — but it costs nothing to keep, and does not assume
   * that contract holds forever.
   */
  private async writeCache(
    question: string,
    version: string,
    cached: CachedAnswer,
  ): Promise<void> {
    try {
      await this.cache.setJson(
        answerKey(version, question, this.answeringConfigFingerprint),
        cached,
        this.answerCacheTtlS,
      );
    } catch (error: unknown) {
      this.logger.error(
        `failed to write answer cache: ${describeError(error)}`,
      );
    }
  }

  /**
   * A cache hit never called a model, so there is nothing to report beyond
   * which provider and model the original answer used — every token count
   * is zero because none were spent, and the price is exactly zero because
   * this response cost nothing beyond a Redis read. A cached refusal has no
   * provider or model to report (`provider`/`model` are null exactly when
   * `grounded` is false), so it gets no row at all, the same as an uncached
   * refusal — this is what keeps `GET /costs` from charging a question
   * twice just because it was answered once and asked again.
   */
  private cachedCost(cached: CachedAnswer): RecordCost | undefined {
    if (cached.provider === null || cached.model === null) {
      return undefined;
    }

    return {
      provider: cached.provider,
      model: cached.model,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      usdCost: 0,
      costSource: 'cached',
      modelReason: 'cached',
    };
  }

  /**
   * A provider answering with no text — a content filter is the case
   * actually seen — is reachable on both paths: `OpenAiCompatibleProvider`
   * only guards against `content === null`, an empty string passes through
   * from `complete()` exactly as an all-empty-delta stream does from
   * `stream()`. Storing '' would read back as a real, blank answer, and
   * inconsistently between the two endpoints depending on which one
   * happened to serve the question; null keeps it distinguishable the same
   * way a refusal's null already is, on both paths alike, so a reader of
   * `answers.answer` — the evaluation suite among them — never has to know
   * which endpoint produced a given row to interpret it. `grounded` stays
   * `true`: a model did answer, and `finishReason` is what explains why
   * there is no text. This governs only what gets stored — the caller still
   * receives the provider's text verbatim, empty string included.
   */
  private storedAnswer(text: string): string | null {
    return text.length > 0 ? text : null;
  }

  /**
   * A completion the provider reported no usage for still gets a ledger row:
   * the request happened and belongs in the ledger, `cost_source: 'unknown'`
   * rather than the row simply not existing — dropping it would make the
   * ledger under-report traffic while looking complete. Token counts default
   * to zero rather than being left absent, since the ledger's columns are
   * NOT NULL; `costSource` is what actually distinguishes "not reported"
   * from a measured zero.
   */
  private buildCost(outcome: {
    provider: string;
    model: string;
    configuredModel: string;
    usage: TokenUsage | null;
    reportedCostUsd: number | null;
    modelReason: string;
  }): RecordCost {
    const { usdCost, costSource } = computeCost(outcome);

    return {
      provider: outcome.provider,
      model: outcome.model,
      promptTokens: outcome.usage?.promptTokens ?? 0,
      completionTokens: outcome.usage?.completionTokens ?? 0,
      cachedTokens: outcome.usage?.cachedTokens ?? 0,
      usdCost,
      costSource,
      modelReason: outcome.modelReason,
    };
  }

  /**
   * Persistence failures are logged, never propagated: by the time this runs
   * the answer has been produced and, on the streaming path, already sent.
   *
   * A cached answer can outlive the chunks its citations name: a re-ingest
   * of the same source (`deleteSourceContent`) deletes and replaces them
   * while this entry still sits in Redis under its old key, for up to
   * `CACHE_ANSWER_TTL_S`. `citations.chunk_id` is `NOT NULL REFERENCES
   * chunks(id)`, so `repository.record`'s single transaction — deliberately
   * atomic, see its own docstring — rolls back the query, answer and ledger
   * rows together on that foreign key alone. Left as a plain failure, a
   * served cache hit would be recorded nowhere at all: no query row, no
   * answer row, no ledger row, for as long as the entry keeps being served.
   * `GET /costs` would under-report it and the evaluation suite would never
   * see it — silently recording nothing is worse than recording an
   * incomplete row. Retrying once, with the citations that no longer
   * resolve dropped, keeps the request in the ledger and the query/answer
   * tables — `grounded` and the answer text are still exactly what was
   * served, only the specific chunks it once cited are gone, which is
   * honest: this codebase does not keep the old chunk rows around to
   * verify them against any more either.
   */
  private async persist(input: RecordInput): Promise<void> {
    try {
      await this.repository.record(input);
    } catch (error: unknown) {
      if (input.citations.length > 0 && isForeignKeyViolation(error)) {
        this.logger.warn(
          `dropping ${input.citations.length} citation(s) referencing chunks that no longer exist (likely a source re-ingested since this answer was cached) and retrying without them: ${describeError(error)}`,
        );
        try {
          await this.repository.record({ ...input, citations: [] });
        } catch (retryError: unknown) {
          this.logger.error(
            `failed to record answer even without citations: ${describeError(retryError)}`,
          );
        }
        return;
      }

      this.logger.error(`failed to record answer: ${describeError(error)}`);
    }
  }
}
