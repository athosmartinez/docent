import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';

import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
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

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      stream: true,
    });

    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta.content;

      // A chunk with no text is normal — role-only and finish-only chunks
      // arrive on the same stream — so it is skipped, not treated as an end.
      if (delta) {
        yield delta;
      }
    }
  }
}
