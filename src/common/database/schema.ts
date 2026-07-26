/**
 * The Kysely schema interface, written by hand rather than generated, so that
 * types do not require a running database to produce. Tables are declared here
 * as the features that own them ship.
 *
 * Kysely creates and manages its own migration bookkeeping tables; they are
 * intentionally absent.
 */
export type DB = Record<never, never>;
