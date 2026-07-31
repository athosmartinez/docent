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
    // (136 documents, 839 chunks): the highest in-corpus best-distance was
    // 0.52843 ("How do I inject a repository into a service?") and the
    // lowest out-of-corpus best-distance was 0.71289 ("How do I configure a
    // Kubernetes ingress?"), over 7 in-corpus and 6 out-of-corpus questions.
    // The populations separated cleanly this time, unlike the RRF score this
    // setting replaced; the default is the midpoint of the gap between them.
    GROUNDING_MAX_DISTANCE: z.coerce.number().positive().default(0.62066),
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
