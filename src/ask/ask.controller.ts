import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { questionHash } from '../common/cache/cache.keys';
import { describeError } from '../common/describe-error';
import {
  MS_PER_MINUTE,
  sharedBucketKey,
  throttleLimits,
} from '../common/throttling/throttling.module';
import { LLM, type LlmProvider } from '../llm/llm.types';
import { AskService } from './ask.service';
import type { AskResult } from './ask.types';
import { askRequestSchema } from './dto/ask-request.dto';
import { buildPrompt, toCitations } from './prompt';

const UI_PAGE = path.join(__dirname, 'ui.html');

const sse = (res: Response, event: string, data: unknown): void => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// This is the first unauthenticated public POST endpoint the service
// exposes. An upstream failure's own text (`connect ECONNREFUSED
// 127.0.0.1:5432`, a bare host and port) has no business reaching a
// browser, so both failure paths below log the real detail server-side and
// send only this fixed string over the wire.
const SERVICE_UNAVAILABLE_MESSAGE =
  'the service is temporarily unavailable, try again shortly';

// Identifies a failing question without ever putting its text in a log
// line — deliberately not a truncated excerpt. Truncation bounds *volume*,
// but the actual risk here is *sensitivity*: a pasted API key, a customer's
// name, a fragment of a private document is overwhelmingly more likely to
// land in a question's first 200 characters than after them, so clipping
// the string only trims the tail of the exact thing that must not reach a
// log line — a log aggregator's retention, access control and export paths
// are not this application's own database's, and `persist` (which writes
// the raw question, but only once an answer already exists) never runs on
// this failure path, so this is a genuinely new place the text would
// otherwise appear.
//
// `questionHash` is the same hash `answerKey` already keys the answer
// cache by (see cache.keys.ts), reused rather than duplicated: it
// identifies the question uniquely — two different long questions sharing
// a 200-character prefix would collide under truncation; a hash collision
// is cryptographically negligible — groups repeated failures of the same
// question in a log search, and, being the identical hash, lets an
// operator check by hand whether the question that just failed had ever
// been answered and cached (`ans:<version>:<hash>`). The character count
// alongside it is what a truncated excerpt's length still told you, with
// none of what it cost.
const QUESTION_HASH_LOG_CHARS = 12;

function questionLogTag(question: string): string {
  const hash = questionHash(question).slice(0, QUESTION_HASH_LOG_CHARS);
  return `q:${hash}, ${question.length} chars`;
}

// /ask and /ask/stream both answer a question through the same LLM call —
// streaming is a transport choice, not a separate operation — so they share
// one rate-limit bucket via `sharedBucketKey`. Left to the guard's default
// per-handler key, a client could double its intended budget on the
// expensive part of this service just by alternating between the two
// routes for the same questions. Exported so `throttling.module.spec.ts`
// can pin the window this applies over without booting the app — the
// per-route `ttl` is as easy to get wrong as the per-route `limit` is, and
// only the latter had a test.
export const ASK_THROTTLE = {
  default: {
    limit: () => throttleLimits.askPerMinute,
    ttl: MS_PER_MINUTE,
    generateKey: sharedBucketKey('ask'),
  },
};

@Controller()
export class AskController {
  private readonly logger = new Logger(AskController.name);

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
  @Throttle(ASK_THROTTLE)
  async ask(@Body() body: unknown): Promise<AskResult> {
    const question = this.parse(body);

    try {
      return await this.service.ask(question);
    } catch (error: unknown) {
      // Embeddings and the answering model are upstream services. When one is
      // down this service is unavailable, not broken, and the class of the
      // status code is what a client reads to decide whether to retry. Nest
      // would otherwise report the default 500.
      this.logger.error(
        `/ask failed [${questionLogTag(question)}]: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException(SERVICE_UNAVAILABLE_MESSAGE);
    }
  }

  @Post('ask/stream')
  // Nest sets the response status before the handler runs, from the HTTP
  // method's default, regardless of @Res() — POST defaults to 201, but an
  // SSE stream is a normal 200 response kept open, not a created resource.
  @HttpCode(200)
  @Throttle(ASK_THROTTLE)
  async stream(@Body() body: unknown, @Res() res: Response): Promise<void> {
    const question = this.parse(body);

    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();

    try {
      const cached = await this.service.cachedAnswer(question);

      if (cached) {
        // A hit is served in the same event order and shape a fresh answer
        // would be, so the client cannot tell the two apart: citations,
        // then the answer, then done. The whole text goes out as one token
        // event rather than several — there is nothing left to stream, and
        // pacing a cached string out with timers would be inventing latency
        // that never happened. A falsy answer covers both a refusal (null)
        // and a grounded-but-empty answer (a cached content-filter result),
        // matching the zero-delta case a fresh stream never emits a token
        // event for either.
        sse(res, 'citations', cached.citations);
        if (cached.answer) {
          sse(res, 'token', cached.answer);
        }
        sse(res, 'done', { grounded: cached.grounded });
        await this.service.recordCacheHit(question, cached);
        res.end();
        return;
      }

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
      const stream = this.llm.stream(buildPrompt(question, chunks));

      for await (const delta of stream) {
        answer += delta;
        sse(res, 'token', delta);
      }

      sse(res, 'done', { grounded: true });
      // A chat completion API reports the model that answered, its finish
      // reason, usage and cost only once the stream has ended — none of it
      // is knowable before this point, so outcome() is read exactly once,
      // here, rather than per chunk.
      await this.service.recordStreamed(
        question,
        chunks,
        answer,
        stream.outcome(),
      );
    } catch (error: unknown) {
      // The status line is long gone by now, so a failure can only be
      // reported inside the stream itself.
      this.logger.error(
        `/ask/stream failed [${questionLogTag(question)}]: ${describeError(error)}`,
      );
      sse(res, 'error', SERVICE_UNAVAILABLE_MESSAGE);
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
