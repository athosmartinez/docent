import { AskService } from './ask.service';
import type { RetrievalService } from '../retrieval/retrieval.service';
import type {
  CompletionResult,
  LlmProvider,
  StreamOutcome,
} from '../llm/llm.types';
import type { AskRepository, RecordInput } from './ask.repository';
import type {
  RetrievalResult,
  RetrievedChunk,
} from '../retrieval/retrieval.types';

const chunk = (id: string): RetrievedChunk => ({
  chunkId: id,
  documentPath: `content/${id}.md`,
  headingPath: [],
  content: `body of ${id}`,
  // The fused score plays no role in grounding any more — only bestDistance
  // does — so its value here is arbitrary.
  score: 1,
});

const outcome = (overrides: Partial<StreamOutcome> = {}): StreamOutcome => ({
  model: 'gpt-4.1-mini',
  provider: 'openai',
  finishReason: 'stop',
  usage: null,
  reportedCostUsd: null,
  modelReason: 'primary',
  ...overrides,
});

/**
 * `record` is `jest.fn()` without a call-signature generic, so every call's
 * argument types as `any` — asserting on `.cost` through nested
 * `expect.objectContaining` would type-check the nesting itself as `any`.
 * Recovering the real, static `RecordInput` shape here lets the tests below
 * assert on `cost` directly instead.
 */
function recordedInput(record: jest.Mock, callIndex = 0): RecordInput {
  const call = record.mock.calls[callIndex] as unknown[];
  return call[0] as RecordInput;
}

function build(
  result: RetrievalResult,
  maxDistance = 0.5,
  completionOverrides: Partial<CompletionResult> = {},
) {
  const retrieval = {
    search: jest.fn().mockResolvedValue(result),
  } as unknown as RetrievalService;

  const completion: CompletionResult = {
    text: 'the answer [1]',
    model: 'gpt-4.1-mini',
    provider: 'openai',
    finishReason: 'stop',
    usage: null,
    reportedCostUsd: null,
    modelReason: 'primary',
    ...completionOverrides,
  };
  const complete = jest.fn().mockResolvedValue(completion);
  const llm: LlmProvider = { complete, stream: jest.fn() };

  const record = jest.fn().mockResolvedValue('answer-id');
  const repository = { record } as unknown as AskRepository;

  return {
    service: new AskService(retrieval, llm, repository, maxDistance),
    complete,
    record,
  };
}

describe('AskService', () => {
  it('answers when the nearest chunk is within the threshold', async () => {
    const { service } = build({ chunks: [chunk('a')], bestDistance: 0.3 });

    const result = await service.ask('how?');

    expect(result.grounded).toBe(true);
    expect(result.answer).toBe('the answer [1]');
    expect(result.citations).toHaveLength(1);
  });

  it('refuses without calling the LLM when the nearest chunk is outside the threshold', async () => {
    const { service, complete } = build({
      chunks: [chunk('a')],
      bestDistance: 0.9,
    });

    const result = await service.ask('what is the capital of France?');

    expect(result.grounded).toBe(false);
    expect(result.answer).toBeNull();
    expect(result.citations).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses when bestDistance is null', async () => {
    const { service, complete } = build({ chunks: [], bestDistance: null });

    const result = await service.ask('anything');

    expect(result.grounded).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('records the refusal', async () => {
    const { service, record } = build({ chunks: [], bestDistance: null });

    await service.ask('anything');

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ grounded: false, answer: null }),
    );
  });

  it('records the answer with its model and citations', async () => {
    const { service, record } = build({
      chunks: [chunk('a')],
      bestDistance: 0.3,
    });

    await service.ask('how?');

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        grounded: true,
        model: 'gpt-4.1-mini',
        provider: 'openai',
      }),
    );
  });

  // `OpenAiCompatibleProvider.complete` only rejects a null content — an
  // empty string (a content filter, in practice) passes straight through,
  // reaching `ask` the same way a zero-delta stream reaches `recordStreamed`.
  it('stores a null answer for an empty completion, while still returning it to the caller', async () => {
    const { service, record } = build(
      { chunks: [chunk('a')], bestDistance: 0.3 },
      0.5,
      { text: '', finishReason: 'content_filter' },
    );

    const result = await service.ask('how?');

    expect(recordedInput(record).answer).toBeNull();
    expect(recordedInput(record).grounded).toBe(true);
    // The wire response is unaffected — only what gets stored changes.
    expect(result.answer).toBe('');
    expect(result.grounded).toBe(true);
  });

  it('records a cost carrying the completion modelReason', async () => {
    const { service, record } = build(
      { chunks: [chunk('a')], bestDistance: 0.3 },
      0.5,
      {
        modelReason: 'fallback: openai timed out',
        usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 0 },
        reportedCostUsd: 0.002,
      },
    );

    await service.ask('how?');

    expect(recordedInput(record).cost).toMatchObject({
      modelReason: 'fallback: openai timed out',
      usdCost: 0.002,
      costSource: 'reported',
    });
  });

  it('records no cost for a refusal', async () => {
    const { service, record } = build({ chunks: [], bestDistance: null });

    await service.ask('anything');

    expect(recordedInput(record).grounded).toBe(false);
    expect(recordedInput(record).cost).toBeUndefined();
  });

  // The request still happened even when the provider reported no usage at
  // all — dropping the row instead of recording it as unpriced would make
  // the ledger under-report traffic while looking complete.
  it('records cost_source unknown rather than dropping the cost, when usage is null', async () => {
    const { service, record } = build(
      { chunks: [chunk('a')], bestDistance: 0.3 },
      0.5,
      { usage: null, reportedCostUsd: null },
    );

    await service.ask('how?');

    expect(recordedInput(record).cost).toMatchObject({
      costSource: 'unknown',
      usdCost: null,
    });
  });

  // `buildCost` maps every `RecordCost` field, not only the three token
  // counts — `provider`/`model` sit right beside them and are exactly as
  // swappable, and a swap there is the hardest kind to notice: both are
  // `string`, so the compiler stays silent, and `computeCost` reads the
  // original (unswapped) object, so the priced amount still comes out
  // right — only the columns `GET /costs` groups by are wrong. `toEqual`
  // against the full object, not `toMatchObject` on a subset, is what makes
  // "the fields you happen to be thinking about" insufficient to pass.
  it('carries every RecordCost field into its own column, not swapped', async () => {
    const { service, record } = build(
      { chunks: [chunk('a')], bestDistance: 0.3 },
      0.5,
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash',
        modelReason: 'fallback: openai timed out',
        usage: { promptTokens: 111, completionTokens: 222, cachedTokens: 333 },
        reportedCostUsd: 0.009,
      },
    );

    await service.ask('how?');

    expect(recordedInput(record).cost).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      promptTokens: 111,
      completionTokens: 222,
      cachedTokens: 333,
      usdCost: 0.009,
      costSource: 'reported',
      modelReason: 'fallback: openai timed out',
    });
  });

  it('still returns the answer when persistence fails', async () => {
    const record = jest.fn().mockRejectedValue(new Error('database is down'));
    const repository = { record } as unknown as AskRepository;
    const search = jest
      .fn()
      .mockResolvedValue({ chunks: [chunk('a')], bestDistance: 0.3 });
    const complete = jest.fn().mockResolvedValue({
      text: 'answer',
      model: 'm',
      provider: 'openai',
      finishReason: 'stop',
    });

    const failing = new AskService(
      { search } as unknown as RetrievalService,
      { complete, stream: jest.fn() },
      repository,
      0.5,
    );

    // Losing the record is bad; returning an error to someone who has the
    // answer is worse.
    await expect(failing.ask('how?')).resolves.toMatchObject({
      grounded: true,
      answer: 'answer',
    });
  });

  // A distance exactly at the threshold is grounded: the check is
  // `bestDistance > maxDistance`, not `>=`. Flipping that operator would turn
  // this refuse.
  it('answers when the nearest chunk sits exactly on the threshold', async () => {
    const { service, complete } = build(
      { chunks: [chunk('a')], bestDistance: 0.5 },
      0.5,
    );

    const result = await service.ask('on the boundary');

    expect(result.grounded).toBe(true);
    expect(complete).toHaveBeenCalled();
  });

  // The vector arm always returns its nearest 20 chunks regardless of how far
  // away they are, so a refusal has to drop them explicitly rather than rely
  // on retrieval having found nothing at all.
  it('refuses even though retrieval found chunks, when none of them are close enough', async () => {
    const { service, complete } = build({
      chunks: [chunk('a'), chunk('b')],
      bestDistance: 0.9,
    });

    const result = await service.ask('what is the capital of France?');

    expect(result.grounded).toBe(false);
    expect(result.citations).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('AskService.recordStreamed', () => {
  it('records a streamed answer with its citations', async () => {
    const { service, record } = build({
      chunks: [chunk('a')],
      bestDistance: 0.3,
    });

    await service.recordStreamed(
      'how?',
      [chunk('a')],
      'the streamed answer [1]',
      outcome(),
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'how?',
        answer: 'the streamed answer [1]',
        grounded: true,
      }),
    );
  });

  it('records a cost for the streamed outcome', async () => {
    const { service, record } = build({
      chunks: [chunk('a')],
      bestDistance: 0.3,
    });

    await service.recordStreamed(
      'how?',
      [chunk('a')],
      'the streamed answer [1]',
      outcome({
        modelReason: 'fallback: openai timed out',
        usage: { promptTokens: 50, completionTokens: 10, cachedTokens: 0 },
        reportedCostUsd: 0.0005,
      }),
    );

    expect(recordedInput(record).cost).toMatchObject({
      modelReason: 'fallback: openai timed out',
      usdCost: 0.0005,
      costSource: 'reported',
    });
  });

  // The `ask()` twin of this test caught a real gap: this one is what
  // proves the streamed path — the one the shipped chat page actually
  // uses — doesn't silently drop the row when a provider ignores the
  // requested `stream_options.include_usage` and reports no usage at all.
  it('records cost_source unknown rather than dropping the cost, when the streamed outcome has no usage', async () => {
    const { service, record } = build({
      chunks: [chunk('a')],
      bestDistance: 0.3,
    });

    await service.recordStreamed(
      'how?',
      [chunk('a')],
      'the streamed answer [1]',
      outcome({ usage: null, reportedCostUsd: null }),
    );

    expect(recordedInput(record).cost).toMatchObject({
      costSource: 'unknown',
      usdCost: null,
    });
  });

  // Same full-shape proofing as the `ask()` twin, for the streamed call
  // site's own object literal — `buildCost` is shared, but each call site
  // still wires its own input into it, so a regression in either wiring
  // needs its own path to be caught on.
  it('carries every RecordCost field into its own column for the streamed outcome, not swapped', async () => {
    const { service, record } = build({
      chunks: [chunk('a')],
      bestDistance: 0.3,
    });

    await service.recordStreamed(
      'how?',
      [chunk('a')],
      'the streamed answer [1]',
      outcome({
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash',
        modelReason: 'fallback: openai timed out',
        usage: { promptTokens: 444, completionTokens: 555, cachedTokens: 666 },
        reportedCostUsd: 0.007,
      }),
    );

    expect(recordedInput(record).cost).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      promptTokens: 444,
      completionTokens: 555,
      cachedTokens: 666,
      usdCost: 0.007,
      costSource: 'reported',
      modelReason: 'fallback: openai timed out',
    });
  });

  // A stream that opens and ends with zero deltas is the router reporting a
  // provider that answered with nothing — a content filter is the case
  // actually seen — not a failure to attempt an answer at all. Storing ''
  // would read back as a real, blank answer, indistinguishable from one that
  // genuinely has no content; null keeps that case honest while grounded
  // stays true because a model did answer.
  it('stores a null answer, not an empty string, when the stream ends with zero deltas', async () => {
    const { service, record } = build({
      chunks: [chunk('a')],
      bestDistance: 0.3,
    });

    await service.recordStreamed(
      'how?',
      [chunk('a')],
      '',
      outcome({ finishReason: 'content_filter' }),
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ answer: null, grounded: true }),
    );
  });

  // Both a refusal and a zero-delta completion store a null answer, and
  // `grounded` is the only column that tells them apart on read-back — a
  // refusal never reached a model, a zero-delta completion did.
  it('keeps a zero-delta completion distinguishable from a refusal', async () => {
    const { service, record } = build({
      chunks: [chunk('a')],
      bestDistance: 0.3,
    });

    await service.recordStreamed(
      'how?',
      [chunk('a')],
      '',
      outcome({ finishReason: 'content_filter' }),
    );
    await service.recordRefusal('anything');

    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ answer: null, grounded: true }),
    );
    expect(record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ answer: null, grounded: false }),
    );
  });

  it('does not throw when persistence fails', async () => {
    const repository = {
      record: jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as AskRepository;

    const llm: LlmProvider = { complete: jest.fn(), stream: jest.fn() };
    const service = new AskService(
      { search: jest.fn() } as unknown as RetrievalService,
      llm,
      repository,
      0.5,
    );

    await expect(
      service.recordStreamed('q', [chunk('a')], 'text', outcome()),
    ).resolves.toBeUndefined();
  });
});

describe('AskService.recordRefusal', () => {
  // The streaming controller's refusal path calls this directly, rather
  // than going through `ask`'s inline refusal — a separate call site the
  // same invariant has to hold at: no model was called, so there is nothing
  // honest to cost.
  it('records no cost', async () => {
    const { service, record } = build({ chunks: [], bestDistance: null });

    await service.recordRefusal('anything');

    expect(recordedInput(record).grounded).toBe(false);
    expect(recordedInput(record).cost).toBeUndefined();
  });

  // `ask()` and `recordStreamed()` each pin this already; `recordRefusal`
  // routes through the same private `persist()`, so today this is drift
  // only — but the streaming controller's refusal branch sends the SSE
  // `done` event before calling this, so a future change that had
  // `recordRefusal` skip `persist()` (call `repository.record` directly,
  // say) would surface a persistence failure as an SSE `error` frame after
  // `done` has already gone out, with nothing here to notice.
  it('does not throw when persistence fails', async () => {
    const repository = {
      record: jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as AskRepository;

    const service = new AskService(
      { search: jest.fn() } as unknown as RetrievalService,
      { complete: jest.fn(), stream: jest.fn() },
      repository,
      0.5,
    );

    await expect(service.recordRefusal('anything')).resolves.toBeUndefined();
  });
});

describe('ask() and recordStreamed() store the same shape', () => {
  // `recordStreamed`'s own docstring says recording it this way "keeps a
  // streamed answer in the same tables as a non-streamed one, which is what
  // lets the evaluation suite read both back the same way" — a reader of
  // `answers.answer` should never need to know which endpoint produced a
  // given row. This pins that promise directly: the same upstream situation
  // (a provider answering with no text) must land in the same stored shape
  // regardless of which path handled it, not merely each in isolation.
  it('both store a null answer, grounded true, for a provider that answered with no text', async () => {
    const { service: askService, record: askRecord } = build(
      { chunks: [chunk('a')], bestDistance: 0.3 },
      0.5,
      { text: '', finishReason: 'content_filter' },
    );
    const { service: streamService, record: streamRecord } = build({
      chunks: [chunk('a')],
      bestDistance: 0.3,
    });

    await askService.ask('how?');
    await streamService.recordStreamed(
      'how?',
      [chunk('a')],
      '',
      outcome({ finishReason: 'content_filter' }),
    );

    const fromAsk = recordedInput(askRecord);
    const fromStream = recordedInput(streamRecord);

    expect(fromAsk.answer).toBeNull();
    expect(fromAsk.answer).toBe(fromStream.answer);
    expect(fromAsk.grounded).toBe(fromStream.grounded);
  });

  // `ask()` pinned model/provider but not finishReason; `recordStreamed`'s
  // finishReason is pinned end-to-end by an e2e test but its model/provider
  // were pinned nowhere at all — each path covered what the other left
  // open. `model`/`provider`/`finishReason` are threaded from a differently
  // named field on each path's own input object (`completion.*` vs
  // `outcome.*`), so nothing shares an implementation the way `buildCost`
  // does — proving both wirings land on the exact value asked for, not just
  // on each other, is what a shared bug in a hypothetical common helper
  // could otherwise slip past.
  it('both record the model, provider and finish reason that answered', async () => {
    const answered = {
      model: 'gpt-4.1-mini',
      provider: 'openai',
      finishReason: 'length',
    };

    const { service: askService, record: askRecord } = build(
      { chunks: [chunk('a')], bestDistance: 0.3 },
      0.5,
      answered,
    );
    const { service: streamService, record: streamRecord } = build({
      chunks: [chunk('a')],
      bestDistance: 0.3,
    });

    await askService.ask('how?');
    await streamService.recordStreamed(
      'how?',
      [chunk('a')],
      'the streamed answer [1]',
      outcome(answered),
    );

    expect(recordedInput(askRecord)).toMatchObject(answered);
    expect(recordedInput(streamRecord)).toMatchObject(answered);
  });
});
