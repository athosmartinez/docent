import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';

import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  LlmStream,
  StreamOutcome,
  TokenUsage,
} from './llm.types';

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

/**
 * Both providers speak the same usage shape; OpenRouter adds `cost`, in
 * credits it prices at one US dollar each. Absent usage stays null rather
 * than becoming zeros — see the ledger's cost_source column for why the
 * distinction is load-bearing.
 */
function normaliseUsage(raw: RawUsage | undefined): TokenUsage | null {
  if (!raw) return null;

  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

@Injectable()
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly client: OpenAI,
    private readonly providerName: string,
    private readonly model: string,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    });

    const choice = response.choices[0];

    if (!choice) {
      throw new Error('completion response carried no choice');
    }

    if (choice.message.content === null) {
      throw new Error('completion response carried no content');
    }

    // The official SDK type has no `cost` field — OpenRouter adds it as an
    // extension the type doesn't know about. Widening to the local RawUsage
    // shape (a structural subset, so no assertion is needed) is enough to
    // read it while the known fields stay checked against the SDK type.
    const raw: RawUsage | undefined = response.usage;

    return {
      text: choice.message.content,
      model: response.model,
      provider: this.providerName,
      finishReason: choice.finish_reason,
      usage: normaliseUsage(raw),
      reportedCostUsd: raw?.cost ?? null,
      modelReason: 'primary',
    };
  }

  stream(request: CompletionRequest): LlmStream {
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    let reportedCostUsd: number | null = null;

    const client = this.client;
    const model = this.model;
    const providerName = this.providerName;

    async function* tokens(): AsyncGenerator<string> {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        stream: true,
        stream_options: { include_usage: true },
      });

      for await (const chunk of response) {
        // The usage chunk carries an empty `choices` array with the usage
        // payload attached, so it must be read before any choices-based
        // guard — reading choices[0] first silently discards it.
        const raw: RawUsage | undefined | null = chunk.usage;

        if (raw) {
          usage = normaliseUsage(raw);
          reportedCostUsd = raw.cost ?? null;
        }

        const choice = chunk.choices[0];

        // The finish reason arrives on the same chunk that carries the last
        // (often empty) delta, so it is captured on every chunk rather than
        // assumed to land on one identifiable as "the last".
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // A chunk with no text is normal — role-only and finish-only chunks
        // arrive on the same stream — so it is skipped, not treated as an
        // end.
        if (choice?.delta.content) {
          yield choice.delta.content;
        }
      }
    }

    const iterator = tokens();

    const outcome = (): StreamOutcome => ({
      model,
      provider: providerName,
      finishReason,
      usage,
      reportedCostUsd,
      modelReason: 'primary',
    });

    return {
      [Symbol.asyncIterator]: () => iterator,
      outcome,
    };
  }
}
