import { AskService } from './ask.service';
import type { RetrievalService } from '../retrieval/retrieval.service';
import type { LlmProvider } from '../llm/llm.types';
import type { AskRepository } from './ask.repository';
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

function build(result: RetrievalResult, maxDistance = 0.5) {
  const retrieval = {
    search: jest.fn().mockResolvedValue(result),
  } as unknown as RetrievalService;

  const complete = jest.fn().mockResolvedValue({
    text: 'the answer [1]',
    model: 'gpt-4.1-mini',
    provider: 'openai',
    finishReason: 'stop',
  });
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
      'gpt-4.1-mini',
      'openai',
      'stop',
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'how?',
        answer: 'the streamed answer [1]',
        grounded: true,
      }),
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
      service.recordStreamed('q', [chunk('a')], 'text', 'm', 'openai', 'stop'),
    ).resolves.toBeUndefined();
  });
});
