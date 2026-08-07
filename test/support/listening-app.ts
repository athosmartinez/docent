import type { INestApplication } from '@nestjs/common';

/**
 * Initialises the application and binds it to an ephemeral port.
 *
 * Binding is what matters. Handed a server that is not already listening,
 * supertest calls `listen(0)` on it itself and closes it again when that one
 * request finishes — so the server's lifetime ends up scoped to a single
 * request it does not own. Two requests overlapping on the same server then
 * race: one closes the listener out from under the other's in-flight socket,
 * which surfaces as `socket hang up` or as a request that never reaches a
 * route. The e2e runner uses Jest's default parallelism, so the overlap is a
 * matter of machine load rather than of any one test doing something unusual.
 *
 * Binding once, here, leaves supertest an address to connect to and nothing to
 * tear down. `app.close()` still releases the port.
 */
export async function listenOnEphemeralPort(
  app: INestApplication,
): Promise<void> {
  await app.init();
  await app.listen(0);
}
