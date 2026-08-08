export interface ChainLink {
  provider: string;
  model: string;
}

export const SUPPORTED_PROVIDERS = ['openai', 'openrouter'] as const;

export function parseLlmChain(raw: string): ChainLink[] {
  const segments = raw.split(',');
  const trimmedSegments = segments.map((entry) => entry.trim());

  // Check for wholly empty chain
  if (trimmedSegments.every((entry) => entry.length === 0)) {
    throw new Error('chain must contain at least one link');
  }

  // Check for stray or doubled commas: some segments are empty
  if (trimmedSegments.some((entry) => entry.length === 0)) {
    throw new Error(
      'chain contains an empty link; check for stray or doubled commas',
    );
  }

  // All segments are now non-empty; parse them
  const links = trimmedSegments.map((entry) => {
    // The first colon only: an OpenRouter model name may contain further
    // colons as a variant suffix, and swallowing them would route to a
    // different model than the one configured.
    const separator = entry.indexOf(':');
    const provider = entry.slice(0, separator).trim();
    const model = entry.slice(separator + 1).trim();

    if (separator === -1 || provider === '' || model === '') {
      throw new Error(`chain link must be provider:model, got '${entry}'`);
    }

    if (!SUPPORTED_PROVIDERS.includes(provider as never)) {
      throw new Error(
        `unknown provider '${provider}', expected one of ${SUPPORTED_PROVIDERS.join(', ')}`,
      );
    }

    return { provider, model };
  });

  const seen = new Set<string>();
  for (const link of links) {
    const pair = `${link.provider}:${link.model}`;
    if (seen.has(pair)) {
      throw new Error(`repeated chain link '${pair}'`);
    }
    seen.add(pair);
  }

  return links;
}
