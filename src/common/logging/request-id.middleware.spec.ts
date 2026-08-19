import type { NextFunction, Request, Response } from 'express';

import { currentRequestId } from './request-context';
import {
  REQUEST_ID_HEADER,
  RequestIdMiddleware,
} from './request-id.middleware';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fakeReq(headerValue: string | undefined): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === REQUEST_ID_HEADER ? headerValue : undefined,
  } as unknown as Request;
}

function fakeRes(): { res: Response; header: () => string | undefined } {
  const headers = new Map<string, string>();
  const res = {
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    },
  } as unknown as Response;
  return { res, header: () => headers.get(REQUEST_ID_HEADER) };
}

describe('RequestIdMiddleware', () => {
  const middleware = new RequestIdMiddleware();

  // The two halves of the same behaviour, in one test: an inbound id is
  // trusted and echoed verbatim; its absence gets a freshly generated one.
  // A mutation that always generates (ignoring the inbound header) would
  // pass a test that only checked "some id is present" — this fails it
  // specifically, because it pins the echoed value back to the exact
  // inbound string.
  it('echoes an inbound id verbatim; generates a fresh one when there is none', () => {
    let observedInside: string | undefined;
    const { res: resWithInbound, header: headerWithInbound } = fakeRes();
    const next: NextFunction = () => {
      observedInside = currentRequestId();
    };

    middleware.use(fakeReq('client-supplied-id'), resWithInbound, next);

    expect(headerWithInbound()).toBe('client-supplied-id');
    expect(observedInside).toBe('client-supplied-id');

    let observedGenerated: string | undefined;
    const { res: resWithoutInbound, header: headerWithoutInbound } = fakeRes();
    const nextGenerated: NextFunction = () => {
      observedGenerated = currentRequestId();
    };

    middleware.use(fakeReq(undefined), resWithoutInbound, nextGenerated);

    expect(headerWithoutInbound()).toMatch(UUID_PATTERN);
    // The value threaded into the request context is the exact same one
    // echoed on the response — not a second, independently generated id.
    expect(observedGenerated).toBe(headerWithoutInbound());
  });

  it('treats a blank inbound header the same as a missing one', () => {
    const { res, header } = fakeRes();
    let observed: string | undefined;

    middleware.use(fakeReq('   '), res, () => {
      observed = currentRequestId();
    });

    expect(header()).toMatch(UUID_PATTERN);
    expect(observed).toBe(header());
  });

  it("is unset again once the middleware's next() call returns", () => {
    const { res } = fakeRes();

    middleware.use(fakeReq('req-x'), res, () => undefined);

    expect(currentRequestId()).toBeUndefined();
  });

  // An unauthenticated caller controls this header entirely. Without a
  // bound, looping POST /ask with an oversized id writes attacker-chosen
  // text into every log line of every one of its requests — the same
  // problem QUESTION_LOG_CHARS exists to prevent for the question, in a
  // larger, completely unbounded form. Both an oversized value and one
  // built from a character no real id format uses fall back to a
  // generated id, the same as no header at all.
  it('falls back to a generated id for an inbound value that is too long', () => {
    const { res, header } = fakeRes();
    const oversized = 'a'.repeat(129);

    middleware.use(fakeReq(oversized), res, () => undefined);

    expect(header()).toMatch(UUID_PATTERN);
    expect(header()).not.toBe(oversized);
  });

  it('accepts an inbound value at exactly the length bound', () => {
    const { res, header } = fakeRes();
    const atBound = 'a'.repeat(128);

    middleware.use(fakeReq(atBound), res, () => undefined);

    expect(header()).toBe(atBound);
  });

  it('falls back to a generated id for an inbound value outside the accepted charset', () => {
    const { res, header } = fakeRes();

    middleware.use(
      fakeReq('evil","level":"log","msg":"spoofed'),
      res,
      () => undefined,
    );

    expect(header()).toMatch(UUID_PATTERN);
  });

  it('accepts UUIDs and other id-shaped values built from the accepted charset', () => {
    const { res, header } = fakeRes();
    const idLike = 'trace-01HXYZ_abc.123';

    middleware.use(fakeReq(idLike), res, () => undefined);

    expect(header()).toBe(idLike);
  });
});
