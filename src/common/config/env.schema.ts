import { z } from 'zod';

import { CHUNK_EMBEDDING_DIMENSIONS } from '../database/schema';
import { describeError } from '../describe-error';
import { parseLlmChain } from '../../llm/llm-chain';

const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Parses `TRUST_PROXY` into the value Express's own `trust proxy` setting
 * accepts — `false`, a hop count, a preset name, or a list of trusted
 * addresses/CIDRs — everything except the literal boolean `true`.
 *
 * `true` trusts every hop, so Express resolves `req.ip` to the *left-most*
 * `X-Forwarded-For` entry. A real proxy *appends* to that header rather
 * than replacing it, so the left-most entry is whatever the client itself
 * sent — under `true`, any client with `curl -H 'X-Forwarded-For: ...'` can
 * pick its own rate-limit bucket, and a rotating value never gets
 * throttled at all. There is no deployment this is the right answer for,
 * so — like an `LLM_CHAIN` link with no key, or an `EMBEDDING_DIMENSIONS`
 * the chunks table cannot store — it fails here, at boot, rather than
 * being discovered by measuring an evadable limit in production.
 */
function parseTrustProxy(
  raw: string,
  ctx: z.RefinementCtx,
): boolean | number | string {
  const value = raw.trim();

  if (value.toLowerCase() === 'true') {
    ctx.addIssue({
      code: 'custom',
      message:
        "'true' trusts every hop, so req.ip resolves to the left-most " +
        'X-Forwarded-For entry — the one the client supplied, not the one ' +
        "a real proxy appended. Use a hop count instead (e.g. '1' to trust " +
        'exactly the reverse proxy directly in front of this process), a ' +
        "preset ('loopback', 'linklocal', 'uniquelocal'), or a " +
        'comma-separated list of trusted addresses/CIDRs.',
    });
    return z.NEVER;
  }

  if (value === '' || value === 'false') {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  if (TRUST_PROXY_PRESETS.has(value)) {
    return value;
  }

  // A comma-separated list of trusted addresses/CIDRs (Express splits and
  // validates each entry itself when the setting is applied) — rejected
  // here only if it is obviously not that, e.g. a stray trailing comma.
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      message:
        'must be false, a hop count, a preset (loopback, linklocal, ' +
        'uniquelocal), or a comma-separated list of trusted addresses/CIDRs',
    });
    return z.NEVER;
  }

  return value;
}

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
    // Also bounds memory only, in the same sense as CACHE_EMBEDDING_TTL_S,
    // for a source added or removed: the key already carries the corpus
    // version, so either always invalidates the entry by changing its key.
    // Re-ingesting an existing source does too only when its refreshed
    // timestamp becomes the newest among ready sources — this TTL is the
    // backstop for the cases it doesn't. Seven days.
    CACHE_ANSWER_TTL_S: z.coerce.number().int().positive().default(604_800),
    // Rate limits, all requests-per-minute per client address. The default
    // applies to every route without its own override; /ask and
    // /ask/stream (one shared budget — see ask.controller.ts) and /ingest
    // get tighter ones because they spend tokens and embeddings
    // respectively, not just server time.
    THROTTLE_DEFAULT_PER_MINUTE: z.coerce.number().int().positive().default(60),
    THROTTLE_ASK_PER_MINUTE: z.coerce.number().int().positive().default(10),
    THROTTLE_INGEST_PER_MINUTE: z.coerce.number().int().positive().default(2),
    // /health is exempt from THROTTLE_DEFAULT_PER_MINUTE (a load balancer,
    // an orchestrator's liveness probe and an uptime monitor legitimately
    // poll it far more often than the default budget assumes, usually all
    // arriving as one address), but not unbounded: it still runs a
    // Postgres query and a Redis PING on every call, so one client looping
    // it with no bound at all would generate unbounded load on both. High
    // enough that no realistic prober fleet reaches it, low enough to
    // still bound a runaway client.
    THROTTLE_HEALTH_PER_MINUTE: z.coerce.number().int().positive().default(300),
    // Express reads the client's real address out of X-Forwarded-For only
    // when the hop that added it is named here. Behind a reverse proxy,
    // leaving this false means every request arrives with the proxy's own
    // address as req.ip, so every client collapses into one rate-limit
    // bucket and one client's burst throttles all of them. See
    // parseTrustProxy above for the accepted forms and why the literal
    // `true` is rejected rather than accepted and misused.
    TRUST_PROXY: z.string().default('false').transform(parseTrustProxy),
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
