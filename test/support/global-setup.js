/**
 * Runs once, in Jest's parent process, before any worker (and therefore any
 * spec file) is spawned. Node's child_process inherits the parent's
 * `process.env` at spawn time, so mutating it here reaches every e2e
 * worker — this is what lets every suite's app import see these values
 * without each of the ~10 spec files needing its own copy of this logic.
 *
 * Every e2e suite except throttling.e2e-spec.ts asks nothing about rate
 * limiting — it fires far more requests, from the same loopback address,
 * in the course of testing retrieval, caching or ingestion than any real
 * client would in the same window. Raising every limit six orders of
 * magnitude above the tightest real one (2/min) leaves no suite able to
 * exhaust a bucket, while leaving the real ThrottlerGuard and its real
 * Redis-backed storage on the path of every request in every suite — the
 * actual composition production runs, not one with the guard removed.
 * throttling.e2e-spec.ts sets its own low values, in the same
 * before-AppModule-is-imported position this file's mutation relies on,
 * to test the real limits instead.
 *
 * `??=` rather than a plain assignment: an operator who exports one of
 * these before running the e2e suite (to test the shipped 60/10/2/300
 * values end to end, say, which no suite otherwise exercises) gets that
 * value honoured instead of silently overridden.
 */
module.exports = async function globalSetup() {
  process.env.THROTTLE_DEFAULT_PER_MINUTE ??= '1000000000';
  process.env.THROTTLE_ASK_PER_MINUTE ??= '1000000000';
  process.env.THROTTLE_INGEST_PER_MINUTE ??= '1000000000';
  process.env.THROTTLE_HEALTH_PER_MINUTE ??= '1000000000';
};
