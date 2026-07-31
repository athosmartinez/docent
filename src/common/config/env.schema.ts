import { z } from 'zod';

import { CHUNK_EMBEDDING_DIMENSIONS } from '../database/schema';

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
    ANSWER_MODEL: z.string().min(1).default('gpt-4.1-mini'),
    ANSWER_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // Measured (scripts/calibrate-floor.ts) against the ingested Nest corpus
    // (136 documents, 839 chunks): the lowest in-corpus best-score was
    // 0.03031 ("How do I create a custom guard?") and the highest
    // out-of-corpus best-score was 0.03062 ("How do I file my taxes in
    // Brazil?"), over 7 in-corpus and 6 out-of-corpus questions. The
    // populations overlap, so no threshold separates them cleanly; the
    // default sits just below the lowest in-corpus score so no answerable
    // question is refused, at the cost of letting the overlapping
    // out-of-corpus question through. See "Dívida conhecida do M2" in
    // _planning/03-roadmap.md — refusing that residual case is deferred to
    // the agentic guardrail in M4, which can inspect retrieved content
    // rather than a single fused score.
    GROUNDING_FLOOR: z.coerce.number().nonnegative().default(0.03),
  })
  .refine((env) => env.EMBEDDING_DIMENSIONS === CHUNK_EMBEDDING_DIMENSIONS, {
    message: `must be ${CHUNK_EMBEDDING_DIMENSIONS}, the dimensionality the chunks column declares`,
    path: ['EMBEDDING_DIMENSIONS'],
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
