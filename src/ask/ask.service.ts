import { Inject, Injectable, Logger } from '@nestjs/common';

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
import type { AskResult } from './ask.types';
import { buildPrompt, toCitations } from './prompt';

@Injectable()
export class AskService {
  private readonly logger = new Logger(AskService.name);

  constructor(
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(LLM) private readonly llm: LlmProvider,
    @Inject(AskRepository) private readonly repository: AskRepository,
    @Inject('GROUNDING_MAX_DISTANCE') private readonly maxDistance: number,
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
    const chunks = await this.retrieveGrounded(question);

    if (!chunks) {
      await this.persist({
        question,
        answer: null,
        grounded: false,
        model: null,
        provider: null,
        finishReason: null,
        citations: [],
      });

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

    // The client gets exactly what the provider returned, empty string
    // included — the null-conversion below is about what gets stored, not
    // what goes out over the wire.
    return { answer: completion.text, grounded: true, citations };
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
    await this.persist({
      question,
      answer: this.storedAnswer(text),
      grounded: true,
      model: outcome.model,
      provider: outcome.provider,
      finishReason: outcome.finishReason,
      citations: toCitations(chunks),
      cost: this.buildCost(outcome),
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
