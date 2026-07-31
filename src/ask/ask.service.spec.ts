import { AskService } from './ask.service';
import type { RetrievalService } from '../retrieval/retrieval.service';
import type { LlmProvider } from '../llm/llm.types';
import type { AskRepository } from './ask.repository';
import type { RetrievedChunk } from '../retrieval/retrieval.types';

const chunk = (id: string, score: number): RetrievedChunk => ({
  chunkId: id,
  documentPath: `content/${id}.md`,
  headingPath: [],
  content: `body of ${id}`,
  score,
});

function build(retrieved: RetrievedChunk[], floor = 0.02) {
  const retrieval = {
    search: jest.fn().mockResolvedValue(retrieved),
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
    service: new AskService(retrieval, llm, repository, floor),
    complete,
    record,
  };
}

describe('AskService', () => {
  it('answers when retrieval clears the floor', async () => {
    const { service } = build([chunk('a', 0.03)]);

    const result = await service.ask('how?');

    expect(result.grounded).toBe(true);
    expect(result.answer).toBe('the answer [1]');
    expect(result.citations).toHaveLength(1);
  });

  it('refuses without calling the LLM when the best score is below the floor', async () => {
    const { service, complete } = build([chunk('a', 0.001)]);

    const result = await service.ask('what is the capital of France?');

    expect(result.grounded).toBe(false);
    expect(result.answer).toBeNull();
    expect(result.citations).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses when retrieval returns nothing at all', async () => {
    const { service, complete } = build([]);

    const result = await service.ask('anything');

    expect(result.grounded).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('records the refusal', async () => {
    const { service, record } = build([]);

    await service.ask('anything');

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ grounded: false, answer: null }),
    );
  });

  it('records the answer with its model and citations', async () => {
    const { service, record } = build([chunk('a', 0.03)]);

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
    const search = jest.fn().mockResolvedValue([chunk('a', 0.03)]);
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
      0.02,
    );

    // Losing the record is bad; returning an error to someone who has the
    // answer is worse.
    await expect(failing.ask('how?')).resolves.toMatchObject({
      grounded: true,
      answer: 'answer',
    });
  });

  // A score exactly at the floor is grounded: the check is `score < floor`,
  // not `score <= floor`. Flipping that operator would turn this refuse.
  it('answers when the best score sits exactly on the floor', async () => {
    const { service, complete } = build([chunk('a', 0.02)], 0.02);

    const result = await service.ask('on the boundary');

    expect(result.grounded).toBe(true);
    expect(complete).toHaveBeenCalled();
  });

  // Retrieval orders results best-first, so only the first entry should
  // decide groundedness. A worse chunk trailing a good one must not refuse.
  it('grounds on the best chunk when a worse one follows it', async () => {
    const { service, complete } = build([chunk('a', 0.03), chunk('b', 0.001)]);

    const result = await service.ask('how?');

    expect(result.grounded).toBe(true);
    expect(complete).toHaveBeenCalled();
  });

  // The mirror of the previous case: a good chunk trailing a bad one must
  // not rescue the answer, because only the first (best) entry is checked.
  it('refuses on the best chunk even when a better one follows it', async () => {
    const { service, complete } = build([chunk('a', 0.001), chunk('b', 0.03)]);

    const result = await service.ask('how?');

    expect(result.grounded).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  // Retrieval did find chunks here — they just scored below the floor. The
  // refusal must not leak them out as citations for an answer never given.
  it('returns no citations on a refusal even though retrieval found chunks', async () => {
    const { service } = build([chunk('a', 0.001), chunk('b', 0.0001)]);

    const result = await service.ask('what is the capital of France?');

    expect(result.citations).toEqual([]);
  });
});
