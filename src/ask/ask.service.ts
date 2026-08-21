import { Inject, Injectable, Logger } from '@nestjs/common';

import { answerKey } from '../common/cache/cache.keys';
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

@Injectable()
export class AskService {
  private readonly logger = new Logger(AskService.name);

  constructor(
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(LLM) private readonly llm: LlmProvider,
    @Inject(AskRepository) private readonly repository: AskRepository,
    @Inject('GROUNDING_MAX_DISTANCE') private readonly maxDistance: number,
    @Inject(CacheService) private readonly cache: CacheService,
    @Inject(CorpusVersion) private readonly corpusVersion: CorpusVersion,
    @Inject('CACHE_ANSWER_TTL_S') private readonly answerCacheTtlS: number,
  ) {}

  /**
   * Retrieval decides whether an answer is possible, before any token is
   * spent. A nearest chunk further than the threshold means no LLM call at
   * all — a model asked to rate its own grounding reports high confidence on
   * hallucinations, so the signal has to come from outside it. Distance is a
   * cost, not a score, so the comparison is against an upper bound: the
   * question is grounded when the nearest chunk is *within* the threshold.
   */
  async retrieveGrounded(question: string): Promise<RetrievedChunk[] | null> {
    const { chunks, bestDistance } = await this.retrieval.search(question);

    if (bestDistance === null || bestDistance > this.maxDistance) {
      return null;
    }

    return chunks;
  }

  async ask(question: string): Promise<AskResult> {
    const cached = await this.cachedAnswer(question);

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
      await this.recordRefusal(question);
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

    await this.writeCache(question, {
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
   * right now. A miss and a hit against a version nothing derives any more
   * (a stale entry outlived by a corpus change, still sitting under its old
   * key until its TTL expires) are indistinguishable here by construction —
   * both simply fail to match the key this call looks up, which is exactly
   * what makes the corpus version doing the invalidating rather than a
   * delete sufficient.
   */
  async cachedAnswer(question: string): Promise<CachedAnswer | null> {
    const version = await this.corpusVersion.current();
    return this.cache.getJson<CachedAnswer>(answerKey(version, question));
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
   */
  async recordStreamed(
    question: string,
    chunks: RetrievedChunk[],
    text: string,
    outcome: StreamOutcome,
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

    await this.writeCache(question, {
      answer: text,
      grounded: true,
      citations,
      provider: outcome.provider,
      model: outcome.model,
      finishReason: outcome.finishReason,
    });
  }

  async recordRefusal(question: string): Promise<void> {
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
    await this.writeCache(question, {
      answer: null,
      grounded: false,
      citations: [],
      provider: null,
      model: null,
      finishReason: null,
    });
  }

  /**
   * The corpus version is looked up again here rather than threaded through
   * from the read side: it is a cheap aggregate over `sources`, and the
   * alternative — carrying a version value across an intervening retrieval
   * and completion call — would let the two calls disagree the moment
   * anything actually changed, which is a real answer racing the exact event
   * this cache exists to react to. Recomputing it at write time means the
   * key an answer is stored under always reflects the corpus at the moment
   * it was actually produced.
   *
   * Every caller of this method runs it *after* the answer already exists —
   * produced, persisted (or the persistence attempt already logged and
   * swallowed), and on the streaming path already sent to the client. Unlike
   * `CacheService`, which fails open by design, `corpusVersion.current()` is
   * a live Postgres query that can reject on a pool timeout or a database
   * restart. Left unguarded, that would turn a request that already
   * succeeded into a thrown error the caller has no way to distinguish from
   * one that never got an answer at all — `/ask` would 503 an answer it just
   * produced and paid for, and `/ask/stream` would append an `event: error`
   * after a `done` frame the client already rendered as complete. Losing
   * this write only means the next identical question pays for another
   * answer instead of hitting the cache — a lost optimisation, never a
   * reason to fail a request that already succeeded.
   */
  private async writeCache(
    question: string,
    cached: CachedAnswer,
  ): Promise<void> {
    try {
      const version = await this.corpusVersion.current();
      await this.cache.setJson(
        answerKey(version, question),
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
   */
  private async persist(input: RecordInput): Promise<void> {
    try {
      await this.repository.record(input);
    } catch (error: unknown) {
      this.logger.error(`failed to record answer: ${describeError(error)}`);
    }
  }
}
