import { Inject, Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/describe-error';
import { LLM, type LlmProvider } from '../llm/llm.types';
import { RetrievalService } from '../retrieval/retrieval.service';
import type { RetrievedChunk } from '../retrieval/retrieval.types';
import { AskRepository } from './ask.repository';
import type { AskResult, Citation } from './ask.types';
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
      answer: completion.text,
      grounded: true,
      model: completion.model,
      provider: completion.provider,
      finishReason: completion.finishReason,
      citations,
    });

    return { answer: completion.text, grounded: true, citations };
  }

  /**
   * Persistence failures are logged, never propagated: by the time this runs
   * the answer has been produced and, on the streaming path, already sent.
   */
  private async persist(input: {
    question: string;
    answer: string | null;
    grounded: boolean;
    model: string | null;
    provider: string | null;
    finishReason: string | null;
    citations: Citation[];
  }): Promise<void> {
    try {
      await this.repository.record(input);
    } catch (error: unknown) {
      this.logger.error(`failed to record answer: ${describeError(error)}`);
    }
  }
}
