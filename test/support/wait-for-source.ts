import type { Server } from 'node:http';
import request from 'supertest';

/**
 * Polls a source until it leaves the async pipeline's in-flight states.
 * Returns on 'failed' as well as the target status — a caller that only
 * checks `status === target` on the *absence* of a throw would silently
 * accept a run that failed instead of succeeding, so every caller must
 * assert the returned status itself.
 */
export async function waitForStatus(
  server: Server,
  id: string,
  target: string,
  attempts = 40,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await request(server).get(`/sources/${id}`);
    const body = response.body as Record<string, unknown>;

    if (body.status === target || body.status === 'failed') {
      return body;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`source ${id} never reached ${target}`);
}

/**
 * Polls until a source reaches 'processing', for tests that need to prove
 * something about the window while a pipeline is actively running.
 */
export async function waitForProcessing(
  server: Server,
  id: string,
  attempts = 40,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await request(server).get(`/sources/${id}`);
    const body = response.body as Record<string, unknown>;

    if (body.status === 'processing') {
      return;
    }

    if (body.status === 'failed') {
      throw new Error(`source ${id} failed before reaching processing`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`source ${id} never reached processing`);
}
