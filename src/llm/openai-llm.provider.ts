import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';

import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  LlmStream,
} from './llm.types';

@Injectable()
export class OpenAiLlmProvider implements LlmProvider {
  constructor(
    private readonly client: OpenAI,
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

    return {
      text: choice.message.content,
      model: response.model,
      provider: 'openai',
      finishReason: choice.finish_reason,
    };
  }

  stream(request: CompletionRequest): LlmStream {
    let finishReason: string | null = null;

    const client = this.client;
    const model = this.model;

    async function* tokens(): AsyncGenerator<string> {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        stream: true,
      });

      for await (const chunk of response) {
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

    return {
      [Symbol.asyncIterator]: () => iterator,
      finishReason: () => finishReason,
    };
  }
}
