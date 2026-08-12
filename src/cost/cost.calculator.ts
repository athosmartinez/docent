import type { ChainLink } from '../llm/llm-chain';
import type { TokenUsage } from '../llm/llm.types';
import { MODEL_PRICES } from './model-prices';

export type CostSource = 'reported' | 'table' | 'cached' | 'unknown';

export interface ComputedCost {
  usdCost: number | null;
  costSource: CostSource;
}

const PER_MILLION = 1_000_000;

/**
 * A reported cost always wins: it is what the provider actually charged, and
 * recomputing over the top of it would let a local estimate silently
 * disagree with a measurement. Only when nothing was reported does this fall
 * back to the price table, and only when the table prices the pair at all —
 * an unpriced or usage-less call comes back `unknown`, never `0`, because a
 * silent zero would sum into a total as though the call had been measured
 * and found free.
 */
export function computeCost(input: {
  provider: string;
  model: string;
  usage: TokenUsage | null;
  reportedCostUsd: number | null;
}): ComputedCost {
  if (input.reportedCostUsd !== null) {
    return { usdCost: input.reportedCostUsd, costSource: 'reported' };
  }

  const price = MODEL_PRICES[`${input.provider}:${input.model}`];

  if (!input.usage || !price) {
    return { usdCost: null, costSource: 'unknown' };
  }

  // promptTokens already includes cachedTokens, so the uncached remainder is
  // what the full input rate applies to. Charging the full rate on all of
  // promptTokens and the cached rate on top would bill the cached portion
  // twice.
  const uncached = input.usage.promptTokens - input.usage.cachedTokens;

  const usdCost =
    (uncached / PER_MILLION) * price.inputPerMillion +
    (input.usage.cachedTokens / PER_MILLION) * price.cachedInputPerMillion +
    (input.usage.completionTokens / PER_MILLION) * price.outputPerMillion;

  return { usdCost, costSource: 'table' };
}

/** Chain links the price table cannot cost, named `provider:model`. */
export function missingPrices(links: ChainLink[]): string[] {
  return links
    .map((link) => `${link.provider}:${link.model}`)
    .filter((pair) => !(pair in MODEL_PRICES));
}
