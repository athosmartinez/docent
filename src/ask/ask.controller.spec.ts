import { Logger } from '@nestjs/common';
import type { Response } from 'express';

import { questionHash } from '../common/cache/cache.keys';
import type { LlmProvider } from '../llm/llm.types';
import { AskController } from './ask.controller';
import type { AskService } from './ask.service';

function buildController(service: Partial<AskService>): AskController {
  const llm: LlmProvider = { complete: jest.fn(), stream: jest.fn() };
  return new AskController(service as unknown as AskService, llm);
}

function fakeResponse(): Response {
  return {
    set: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  } as unknown as Response;
}

/**
 * `AskController` builds its own `new Logger(AskController.name)`, so
 * spying on the shared `Logger.prototype.error` is what intercepts it —
 * there is no injected logger instance to substitute.
 */
describe('AskController — failure logging', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs a question hash tag and the error detail for /ask — never the question text', async () => {
    const question = 'what does docent do?';
    const controller = buildController({
      ask: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    });

    await expect(controller.ask({ question })).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] as [string];
    expect(message).not.toContain(question);
    expect(message).toContain(`q:${questionHash(question).slice(0, 12)}`);
    expect(message).toContain(`${question.length} chars`);
    expect(message).toContain('connect ECONNREFUSED');
  });

  it('logs a question hash tag and the error detail for /ask/stream — never the question text', async () => {
    const question = 'how do I ingest a source?';
    const controller = buildController({
      cachedAnswer: jest
        .fn()
        .mockRejectedValue(new Error('connect ECONNREFUSED')),
    });

    await controller.stream({ question }, fakeResponse());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] as [string];
    expect(message).not.toContain(question);
    expect(message).toContain(`q:${questionHash(question).slice(0, 12)}`);
    expect(message).toContain(`${question.length} chars`);
    expect(message).toContain('connect ECONNREFUSED');
  });

  // The hash is the same one `answerKey` keys the answer cache by (see
  // cache.keys.ts) — deliberately reused, not reimplemented, so a failure
  // log line and a cache key for the same question are directly
  // comparable. A mutation that hashed something else (e.g. an
  // un-normalised question, or a different algorithm) would still pass a
  // test that only checked "some hash-shaped string is present"; this one
  // checks the exact value.
  it('the logged hash is exactly questionHash of the question, joinable to the answer cache key', async () => {
    const question = 'How do I use pipes for   validation?';
    const controller = buildController({
      ask: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(controller.ask({ question })).rejects.toThrow();

    const [message] = errorSpy.mock.calls[0] as [string];
    const fullHash = questionHash(question);
    expect(message).toContain(`q:${fullHash.slice(0, 12)}`);
    // Not the tail of the same hash by coincidence — the first 12 hex
    // characters specifically, matching what questionLogTag slices.
    expect(fullHash.slice(0, 12)).not.toBe(fullHash.slice(12, 24));
  });

  // A long question (askRequestSchema allows up to 2000 characters) proves
  // the same thing a short one does — nothing about length changes what
  // gets logged, because the text itself never enters the message at all,
  // truncated or otherwise.
  it('a long question is identified the same way — by hash and length, never by its text', async () => {
    const longQuestion = 'why '.repeat(500).trim();
    const controller = buildController({
      ask: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(controller.ask({ question: longQuestion })).rejects.toThrow();

    const [message] = errorSpy.mock.calls[0] as [string];
    expect(message).not.toContain(longQuestion);
    expect(message).not.toContain('why why why');
    expect(message).toContain(`${longQuestion.length} chars`);
    expect(message.length).toBeLessThan(longQuestion.length);
  });

  // The concern the hash replaces truncation for: a pasted secret is
  // overwhelmingly likely to sit in a question's first 200 characters, so
  // a truncated excerpt would have carried it straight into the log
  // stream. The hash carries none of the text at all, regardless of where
  // in the question anything sensitive sits.
  it('never leaks a secret embedded early in the question, unlike a truncated excerpt would', async () => {
    const question = 'my api key is sk-FAKE-abc123, why does validation fail?';
    const controller = buildController({
      ask: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(controller.ask({ question })).rejects.toThrow();

    const [message] = errorSpy.mock.calls[0] as [string];
    expect(message).not.toContain('sk-FAKE-abc123');
  });
});
