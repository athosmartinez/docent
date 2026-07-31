import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { describeError } from '../common/describe-error';
import { LLM, type LlmProvider } from '../llm/llm.types';
import { AskService } from './ask.service';
import type { AskResult } from './ask.types';
import { askRequestSchema } from './dto/ask-request.dto';
import { buildPrompt, toCitations } from './prompt';

const UI_PAGE = path.join(__dirname, 'ui.html');

const sse = (res: Response, event: string, data: unknown): void => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

@Controller()
export class AskController {
  constructor(
    @Inject(AskService) private readonly service: AskService,
    @Inject(LLM) private readonly llm: LlmProvider,
  ) {}

  @Get()
  async page(@Res() res: Response): Promise<void> {
    res.type('html').send(await readFile(UI_PAGE, 'utf8'));
  }

  @Post('ask')
  // Nest's default status for POST is 201; this endpoint returns the
  // existing answer to a question, not a created resource.
  @HttpCode(200)
  async ask(@Body() body: unknown): Promise<AskResult> {
    const question = this.parse(body);

    try {
      return await this.service.ask(question);
    } catch (error: unknown) {
      // Embeddings and the answering model are upstream services. When one is
      // down this service is unavailable, not broken, and the class of the
      // status code is what a client reads to decide whether to retry. Nest
      // would otherwise report the default 500.
      throw new ServiceUnavailableException(describeError(error));
    }
  }

  @Post('ask/stream')
  // Nest sets the response status before the handler runs, from the HTTP
  // method's default, regardless of @Res() — POST defaults to 201, but an
  // SSE stream is a normal 200 response kept open, not a created resource.
  @HttpCode(200)
  async stream(@Body() body: unknown, @Res() res: Response): Promise<void> {
    const question = this.parse(body);

    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();

    try {
      const chunks = await this.service.retrieveGrounded(question);

      if (!chunks) {
        sse(res, 'citations', []);
        sse(res, 'done', { grounded: false });
        await this.service.recordRefusal(question);
        res.end();
        return;
      }

      // Citations go first because they are already known — they are the
      // retrieved chunks — so the page can render sources while the answer is
      // still being written.
      sse(res, 'citations', toCitations(chunks));

      let answer = '';

      for await (const delta of this.llm.stream(
        buildPrompt(question, chunks),
      )) {
        answer += delta;
        sse(res, 'token', delta);
      }

      sse(res, 'done', { grounded: true });
      // model/provider are recorded null here: the streaming API reports them
      // per chunk rather than once, and threading them through is work M3
      // redoes once a router names the provider that actually served the
      // request.
      await this.service.recordStreamed(
        question,
        chunks,
        answer,
        null,
        null,
        'stop',
      );
    } catch (error: unknown) {
      // The status line is long gone by now, so a failure can only be
      // reported inside the stream itself.
      sse(res, 'error', describeError(error));
    } finally {
      res.end();
    }
  }

  private parse(body: unknown): string {
    const parsed = askRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
      );
    }

    return parsed.data.question;
  }
}
