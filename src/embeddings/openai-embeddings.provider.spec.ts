import { OpenAiEmbeddingsProvider } from './openai-embeddings.provider';

interface CreateCall {
  model: string;
  input: string[];
  dimensions: number;
}

function makeClient(
  handler: (call: CreateCall) => {
    data: { embedding: number[]; index: number }[];
  },
) {
  const calls: CreateCall[] = [];

  const client = {
    embeddings: {
      create: (params: CreateCall) => {
        calls.push(params);
        return Promise.resolve(handler(params));
      },
    },
  };

  return { client, calls };
}

describe('OpenAiEmbeddingsProvider', () => {
  it('passes the configured model and dimensionality', async () => {
    const { client, calls } = makeClient((call) => ({
      data: call.input.map((_text, index) => ({ embedding: [index], index })),
    }));
    const provider = new OpenAiEmbeddingsProvider(
      client as never,
      'text-embedding-3-large',
      3072,
    );

    await provider.embed(['a']);

    expect(calls[0]?.model).toBe('text-embedding-3-large');
    expect(calls[0]?.dimensions).toBe(3072);
  });

  it('splits large inputs into batches instead of one oversized request', async () => {
    const { client, calls } = makeClient((call) => ({
      data: call.input.map((_text, index) => ({ embedding: [index], index })),
    }));
    const provider = new OpenAiEmbeddingsProvider(client as never, 'm', 3);
    const texts = Array.from({ length: 250 }, (_v, i) => `text ${i}`);

    const result = await provider.embed(texts);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.input).toHaveLength(100);
    expect(calls[2]?.input).toHaveLength(50);
    expect(result).toHaveLength(250);
  });

  it('orders results by the index the API reports, not by arrival', async () => {
    const { client } = makeClient((call) => ({
      // The API documents an index on every item precisely because the array
      // order is not guaranteed; returning it reversed must not corrupt the
      // mapping from text to vector.
      data: call.input
        .map((_text, index) => ({ embedding: [index], index }))
        .reverse(),
    }));
    const provider = new OpenAiEmbeddingsProvider(client as never, 'm', 3);

    const result = await provider.embed(['a', 'b', 'c']);

    expect(result).toEqual([[0], [1], [2]]);
  });

  it('returns an empty array without calling the API', async () => {
    const { client, calls } = makeClient(() => ({ data: [] }));
    const provider = new OpenAiEmbeddingsProvider(client as never, 'm', 3);

    await expect(provider.embed([])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('fails loudly when the API returns fewer vectors than inputs', async () => {
    const { client } = makeClient(() => ({
      data: [{ embedding: [0], index: 0 }],
    }));
    const provider = new OpenAiEmbeddingsProvider(client as never, 'm', 3);

    await expect(provider.embed(['a', 'b'])).rejects.toThrow(/expected 2/i);
  });
});
