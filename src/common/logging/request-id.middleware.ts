import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import { requestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';

// Generous enough for any real correlation id — a UUID is 36 characters,
// and a composite trace id (a gateway's own id plus a span, say) rarely
// approaches this — while still bounding the worst case: an unauthenticated
// caller can send whatever it likes here, and every value survives into
// every log line of the request. QUESTION_LOG_CHARS bounds a question the
// same way, for the same reason, at a similar order of magnitude.
const REQUEST_ID_MAX_CHARS = 128;

// Matches the character set every real id format this header carries in
// practice already uses (UUIDs, ULIDs, most gateways' own generated ids) —
// deliberately not "anything JSON can encode": JSON-encoding already makes
// injecting a forged log record impossible (a `"` inside the header value
// comes out escaped, not as a structural break), but an unbounded charset
// would still let arbitrary attacker-chosen text ride into every line under
// a technically-safe encoding.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function isAcceptableRequestId(value: string): boolean {
  return value.length <= REQUEST_ID_MAX_CHARS && REQUEST_ID_PATTERN.test(value);
}

/**
 * The first thing every request runs through, and the one point every log
 * line's correlation depends on downstream. An inbound `x-request-id` is
 * trusted and echoed back rather than replaced, provided it looks like an
 * id and not an attempt to write arbitrary attacker-chosen text into every
 * line of the request: a caller that already generates one — a gateway,
 * another service earlier in a call chain — gets the same id in its own
 * logs and in this service's, which is the entire point of the header
 * existing. A request with none (blank, oversized, or built from
 * characters no real id format uses) gets a fresh one from `randomUUID()`,
 * the same as a request with no header at all.
 *
 * Running the rest of the pipeline inside `requestContext.run` is what makes
 * the id readable from `currentRequestId()` at any depth `next()` eventually
 * reaches — guards, interceptors, the handler, anything they call, however
 * many `await`s away — without threading it through every signature between
 * here and there.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header(REQUEST_ID_HEADER)?.trim();
    const requestId =
      inbound && isAcceptableRequestId(inbound) ? inbound : randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);
    requestContext.run({ requestId }, next);
  }
}
