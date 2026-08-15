import { z } from 'zod';

import { CHUNK_EMBEDDING_DIMENSIONS } from '../database/schema';
import { describeError } from '../describe-error';
import { parseLlmChain } from '../../llm/llm-chain';

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    OPENAI_API_KEY: z.string().min(1),
    EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-large'),
    EMBEDDING_DIMENSIONS: z.coerce
      .number()
      .int()
      .positive()
      .default(CHUNK_EMBEDDING_DIMENSIONS),
    RETRIEVAL_TOP_N: z.coerce.number().int().positive().default(20),
    RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(8),
    RRF_K: z.coerce.number().int().positive().default(60),
    // One link by default. The fallback chain is opt-in because every
    // provider named here must have a key, and a fresh clone has only
    // OPENAI_API_KEY — defaulting to two links would mean the service does
    // not start until someone signs up for a second provider.
    LLM_CHAIN: z.string().min(1).default('openai:gpt-4.1-mini'),
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    ANSWER_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // Measured (scripts/calibrate-floor.ts) against the ingested Nest corpus
    // (136 documents, 839 chunks), over 30 in-corpus questions (drawn from
    // the corpus's own headings) and 14 out-of-corpus ones: the populations
    // overlap by a hair rather than separating cleanly. The highest
    // in-corpus best-distance was 0.61568 ("How do I upload a file?"), which
    // is *closer* than the lowest out-of-corpus best-distance, 0.60737 ("How
    // do I write a Dockerfile for a Python Flask app?"). No single threshold
    // gets every measured question right, so the default is the highest
    // in-corpus distance itself: refusing a question the corpus can
    // actually answer costs more than answering one that merely sounds
    // related. Cosine distance never exceeds 2, so a configured value at or
    // above it makes `bestDistance > GROUNDING_MAX_DISTANCE` false for
    // every possible distance — refusal never fires. The bound is
    // exclusive (`lt`, not `max`/`lte`) precisely to close that: 2 itself
    // is exactly as broken as anything above it, not a safe edge.
    GROUNDING_MAX_DISTANCE: z.coerce.number().positive().lt(2).default(0.61568),
    // Bounds memory only. Staleness is impossible by construction — the
    // model and dimensionality are part of the cache key itself, so a
    // changed setting changes the key rather than serving an old vector
    // under it.
    CACHE_EMBEDDING_TTL_S: z.coerce
      .number()
      .int()
      .positive()
      .default(2_592_000),
  })
  .refine((env) => env.EMBEDDING_DIMENSIONS === CHUNK_EMBEDDING_DIMENSIONS, {
    message: `must be ${CHUNK_EMBEDDING_DIMENSIONS}, the dimensionality the chunks column declares`,
    path: ['EMBEDDING_DIMENSIONS'],
  })
  .superRefine((env, ctx) => {
    let links;

    try {
      links = parseLlmChain(env.LLM_CHAIN);
    } catch (error: unknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_CHAIN'],
        message: describeError(error),
      });
      return;
    }

    // A link whose provider has no key is a link that always fails, which
    // looks exactly like a healthy chain until the primary breaks.
    const keys: Record<string, string | undefined> = {
      openai: env.OPENAI_API_KEY,
      openrouter: env.OPENROUTER_API_KEY,
    };

    for (const link of links) {
      if (!keys[link.provider]) {
        ctx.addIssue({
          code: 'custom',
          path: ['LLM_CHAIN'],
          message: `link '${link.provider}:${link.model}' needs ${link.provider.toUpperCase()}_API_KEY`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
