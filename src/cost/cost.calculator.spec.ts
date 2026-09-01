import { computeCost, missingPrices } from './cost.calculator';
import { MODEL_PRICES } from './model-prices';

const usage = {
  promptTokens: 1_000_000,
  completionTokens: 1_000_000,
  cachedTokens: 0,
};

describe('computeCost', () => {
  it('prefers the cost the provider reported', () => {
    expect(
      computeCost({
        provider: 'openrouter',
        configuredModel: 'google/gemini-2.5-flash',
        usage,
        reportedCostUsd: 0.0042,
      }),
    ).toEqual({ usdCost: 0.0042, costSource: 'reported' });
  });

  it('falls back to the price table when nothing was reported', () => {
    const price = MODEL_PRICES['openai:gpt-4.1-mini'];
    if (!price) throw new Error('fixture price missing');

    expect(
      computeCost({
        provider: 'openai',
        configuredModel: 'gpt-4.1-mini',
        usage,
        reportedCostUsd: null,
      }),
    ).toEqual({
      usdCost: price.inputPerMillion + price.outputPerMillion,
      costSource: 'table',
    });
  });

  // prompt_tokens already contains the cached ones. Charging the full input
  // rate on top of the cached rate bills the cached portion twice, which is
  // the entire reason the provider reports the split at all.
  it('charges cached input at the cached rate, not on top of the full rate', () => {
    const price = MODEL_PRICES['openai:gpt-4.1-mini'];
    if (!price) throw new Error('fixture price missing');

    const half = computeCost({
      provider: 'openai',
      configuredModel: 'gpt-4.1-mini',
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 0,
        cachedTokens: 500_000,
      },
      reportedCostUsd: null,
    });

    expect(half.usdCost).toBeCloseTo(
      price.inputPerMillion / 2 + price.cachedInputPerMillion / 2,
      10,
    );
  });

  it('reports unknown, not zero, for a model with no price and no report', () => {
    expect(
      computeCost({
        provider: 'openai',
        configuredModel: 'a-model-nobody-priced',
        usage,
        reportedCostUsd: null,
      }),
    ).toEqual({ usdCost: null, costSource: 'unknown' });
  });

  it('reports unknown when the provider sent no usage at all', () => {
    expect(
      computeCost({
        provider: 'openai',
        configuredModel: 'gpt-4.1-mini',
        usage: null,
        reportedCostUsd: null,
      }),
    ).toEqual({ usdCost: null, costSource: 'unknown' });
  });

  // promptTokens is contractually supposed to already contain cachedTokens,
  // but nothing on the wire enforces that. A provider that reports more
  // cached tokens than prompt tokens has contradicted its own contract, and
  // the split cannot be trusted enough to price — this must not come back as
  // a negative dollar figure labelled 'table'.
  it('reports unknown, not a negative figure, when cachedTokens exceeds promptTokens', () => {
    expect(
      computeCost({
        provider: 'openai',
        configuredModel: 'gpt-4.1-mini',
        usage: { promptTokens: 100, cachedTokens: 150, completionTokens: 0 },
        reportedCostUsd: null,
      }),
    ).toEqual({ usdCost: null, costSource: 'unknown' });
  });

  // The defect this pins: a provider's response can report a more specific
  // model id than what was configured (OpenAI resolves an alias to the
  // dated snapshot that served it) — computeCost has no `model` field to
  // receive that on any more, only `configuredModel`, so there is nothing
  // for a served-model string to accidentally reach the price table with.
  it('prices by the configured model regardless of what the provider echoes as served, since only the configured one is ever passed in', () => {
    const price = MODEL_PRICES['openai:gpt-4.1-mini'];
    if (!price) throw new Error('fixture price missing');

    // No `model` field exists on the input at all — this is the type-level
    // half of the fix: there is no served-model string in scope here for a
    // future change to reach for by mistake.
    const result = computeCost({
      provider: 'openai',
      configuredModel: 'gpt-4.1-mini',
      usage,
      reportedCostUsd: null,
    });

    expect(result).toEqual({
      usdCost: price.inputPerMillion + price.outputPerMillion,
      costSource: 'table',
    });
  });

  // A link genuinely absent from the price table must still come back
  // unknown after the fix — the fix threads the *configured* model through
  // more reliably, it must not make "unpriced" unreachable.
  it('still reports unknown for a configured model genuinely absent from the price table', () => {
    expect(
      computeCost({
        provider: 'openai',
        configuredModel: 'gpt-4.1-mini-2025-04-14', // a real snapshot id, not in MODEL_PRICES
        usage,
        reportedCostUsd: null,
      }),
    ).toEqual({ usdCost: null, costSource: 'unknown' });
  });
});

describe('missingPrices', () => {
  it('names links the table does not price', () => {
    expect(missingPrices([{ provider: 'openai', model: 'unpriced' }])).toEqual([
      'openai:unpriced',
    ]);
  });

  it('is empty for the default chain', () => {
    expect(
      missingPrices([
        { provider: 'openai', model: 'gpt-4.1-mini' },
        { provider: 'openrouter', model: 'google/gemini-2.5-flash' },
      ]),
    ).toEqual([]);
  });
});
