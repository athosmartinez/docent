import { JsonLogger } from './json.logger';
import { requestContext } from './request-context';

interface Captured {
  spy: jest.SpyInstance;
  lines: () => string[];
}

function capture(stream: NodeJS.WriteStream): Captured {
  const written: string[] = [];
  const spy = jest
    .spyOn(stream, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      written.push(chunk.toString());
      return true;
    });
  return { spy, lines: () => written };
}

/** `JSON.parse` returns `any`; this is the one place that gets asserted away. */
function parseLine<T>(line: string | undefined): T {
  return JSON.parse(line ?? '') as T;
}

describe('JsonLogger', () => {
  let stdout!: Captured;
  let stderr!: Captured;
  let logger!: JsonLogger;

  beforeEach(() => {
    stdout = capture(process.stdout);
    stderr = capture(process.stderr);
    logger = new JsonLogger();
  });

  afterEach(() => {
    stdout.spy.mockRestore();
    stderr.spy.mockRestore();
  });

  // 'log'/'debug'/'verbose' are routine operation; 'warn'/'error'/'fatal' are
  // what an operator or a collector's alerting actually watches for — the
  // same split Nest's own ConsoleLogger makes between the two streams.
  // `stdout`/`stderr` are re-captured fresh in `beforeEach` for every
  // iteration, so the table below names a *stream*, not a captured
  // instance — resolving it to `stdout`/`stderr` has to happen inside the
  // test body, after that iteration's `beforeEach` has already run, not at
  // table-construction time (which runs once, during test collection,
  // before any `beforeEach` at all).
  it.each([
    ['log', 'stdout'] as const,
    ['debug', 'stdout'] as const,
    ['verbose', 'stdout'] as const,
    ['warn', 'stderr'] as const,
    ['error', 'stderr'] as const,
    ['fatal', 'stderr'] as const,
  ])(
    '%s writes exactly one line, to the expected stream',
    (level, streamName) => {
      logger[level]('hello');

      const target = streamName === 'stdout' ? stdout : stderr;
      const other = streamName === 'stdout' ? stderr : stdout;

      expect(target.spy).toHaveBeenCalledTimes(1);
      expect(other.spy).not.toHaveBeenCalled();

      const [line] = target.lines();
      expect(line?.endsWith('\n')).toBe(true);
      const parsed = parseLine<{ level: string; msg: unknown }>(line);
      expect(parsed.level).toBe(level);
      expect(parsed.msg).toBe('hello');
    },
  );

  // The one invariant this whole format exists to guarantee: a message
  // carrying a newline cannot split a record into two lines, because every
  // value is JSON-encoded and JSON.stringify escapes '\n' inside a string
  // rather than emitting a real line break. This service's SSE frames rely
  // on the identical property for the identical reason.
  it('keeps a message containing a newline on a single line', () => {
    logger.log('first line\nsecond line');

    expect(stdout.spy).toHaveBeenCalledTimes(1);
    const [raw] = stdout.lines();
    const body = (raw ?? '').replace(/\n$/, '');

    // The one trailing '\n' this call() appended is stripped above — what's
    // left must contain no further newline at all.
    expect(body.includes('\n')).toBe(false);

    const parsed = parseLine<{ msg: string }>(body);
    expect(parsed.msg).toBe('first line\nsecond line');
  });

  // The two halves of the same mechanism: inside a request the id set by
  // requestContext.run is picked up; outside one, the key is genuinely
  // absent (not present as null/undefined) rather than merely happening to
  // read as falsy.
  it('carries the request id from the surrounding context, and omits it entirely with none', () => {
    requestContext.run({ requestId: 'req-123' }, () => logger.log('inside'));
    logger.log('outside');

    const [insideLine, outsideLine] = stdout.lines();
    const inside = parseLine<{ requestId?: string }>(insideLine);
    const outside = parseLine<Record<string, unknown>>(outsideLine);

    expect(inside.requestId).toBe('req-123');
    expect('requestId' in outside).toBe(false);
  });

  // Nest's Logger wrapper normalises every call into one of two shapes
  // before it reaches a LoggerService: `(message, context)` for
  // log/warn/debug/verbose/fatal, and `(message, stack, context)` for
  // error — the stack slot always undefined on every call site in this
  // codebase and in Nest's own internals. Both shapes must resolve the
  // trailing string as context; testing only one would leave the other's
  // call shape unverified.
  it('reads context as the trailing string, in both call shapes Nest actually produces', () => {
    logger.warn('two-arg form', 'TwoArgContext');
    logger.error('three-arg form', undefined, 'ThreeArgContext');

    const [warnLine, errorLine] = stderr.lines();
    const warned = parseLine<{ context?: string; msg: string }>(warnLine);
    const errored = parseLine<{ context?: string; msg: string }>(errorLine);

    expect(warned.context).toBe('TwoArgContext');
    expect(warned.msg).toBe('two-arg form');
    expect(errored.context).toBe('ThreeArgContext');
    expect(errored.msg).toBe('three-arg form');
  });

  // `JSON.stringify(new Error('x'))` reads only an Error's own enumerable
  // properties — none on any engine — and serialises to '{}', discarding
  // the message entirely. Nest's own global exception handling logs a raw
  // exception exactly this way (`logger.error(exception)`, no
  // stringification), so this is the call shape that actually reaches
  // production, not a hypothetical. A plain data object with no `.stack` is
  // the other half of the same check: it must pass through untouched,
  // proving the Error-detection is not so eager it mangles an ordinary
  // structured payload. The stack itself — file, line, column — must also
  // survive: switching to this format must not cost every stack trace in
  // the process just because `describeError` only reads `.message`.
  it('renders an error-like message through describeError plus its own stack, and leaves a plain object alone', () => {
    const error = new Error('boom');
    logger.error(error);
    logger.log({ event: 'ingested', count: 5 });

    const [errorLine, logLine] = [stderr.lines()[0], stdout.lines()[0]];
    const errored = parseLine<{ msg: unknown }>(errorLine);
    const logged = parseLine<{ msg: unknown }>(logLine);

    expect(errored.msg).not.toEqual({});
    expect(String(errored.msg)).toContain('boom');
    // error.stack always repeats "Error: boom" on its first line — the
    // interesting property this pins is a real frame further down it,
    // which describeError's own .message-only reading can never produce.
    expect(String(errored.msg)).toContain(String(error.stack).split('\n')[1]);
    expect(logged.msg).toEqual({ event: 'ingested', count: 5 });
  });

  // The realm-independent case describeError exists for: an AggregateError
  // shape whose own `.message` is empty, detail living on `.code`/`.errors`
  // instead — duck-typed here by `.stack` being a string, since
  // `instanceof Error` is exactly what fails across the realm boundary this
  // guards against. The raw stack text must appear too, not just the
  // recovered code/errors summary.
  it('recovers detail from an AggregateError-shaped value with an empty message, stack included', () => {
    logger.error({
      message: '',
      code: 'ECONNREFUSED',
      errors: [{ message: 'connect ECONNREFUSED 127.0.0.1:5432' }],
      stack: 'AggregateError\n    at connect (node:net)',
    });

    const [line] = stderr.lines();
    const parsed = parseLine<{ msg: unknown }>(line);
    expect(parsed.msg).toContain('ECONNREFUSED');
    expect(parsed.msg).toContain('at connect (node:net)');
  });

  // Nest's own idiom for a caller that already has a stack in hand:
  // `logger.error(message, err.stack)` — resolved by shape (does the
  // string actually look like a stack trace?), not by position, the same
  // way Nest's own ConsoleLogger resolves the identical ambiguity. Tested
  // with and without a context alongside it, since the two-argument and
  // three-argument forms parse the trailing position differently.
  it('recognises an explicit stack argument to error(), with and without a context alongside it', () => {
    const stack =
      'Error: handler blew up\n    at Object.<anonymous> (/app/probe.js:4:13)';

    logger.error('handler blew up', stack);
    logger.error('handler blew up', stack, 'AskService');

    const [noContextLine, withContextLine] = stderr.lines();
    const noContext = parseLine<{ context?: string; msg: string }>(
      noContextLine,
    );
    const withContext = parseLine<{ context?: string; msg: string }>(
      withContextLine,
    );

    expect(noContext.context).toBeUndefined();
    expect(noContext.msg).toBe(`handler blew up\n${stack}`);

    expect(withContext.context).toBe('AskService');
    expect(withContext.msg).toBe(`handler blew up\n${stack}`);
  });

  // A stack-shaped string is never mistaken for a context, in either
  // direction: a real context name (a short class/module identifier) never
  // matches the stack-trace shape, and a real stack is never treated as a
  // context just because it is the sole trailing argument.
  it('does not mistake a plain context string for a stack, or vice versa', () => {
    logger.error('plain message', 'PlainContext');

    const [line] = stderr.lines();
    const parsed = parseLine<{ context?: string; msg: string }>(line);
    expect(parsed.context).toBe('PlainContext');
    expect(parsed.msg).toBe('plain message');
  });

  // LoggerService's contract allows more than message+context — a caller
  // could pass structured data (`logger.log('msg', { meta })`). No call
  // site in this codebase does this today, but dropping it silently would
  // be worse than an unfamiliar shape: it is carried, not discarded.
  it('carries extra optionalParams instead of silently dropping them', () => {
    logger.log('msg', { meta: 'value' }, 'WithExtras');

    const [line] = stdout.lines();
    const parsed = parseLine<{ context?: string; msg: unknown }>(line);
    expect(parsed.context).toBe('WithExtras');
    expect(parsed.msg).toEqual(['msg', { meta: 'value' }]);
  });

  // A circular reference and a BigInt both throw inside JSON.stringify with
  // no replacer at all. Every call site of this class is either ordinary
  // request handling or an error handler; a second, unrelated exception
  // thrown while trying to log the first must never happen.
  it('never throws on a circular reference or a BigInt, and still emits one line', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    expect(() => logger.log(circular)).not.toThrow();
    expect(() => logger.log({ n: 10n })).not.toThrow();

    const [circularLine, bigintLine] = stdout.lines();
    const parsedCircular = parseLine<{ msg: { a: number; self: unknown } }>(
      circularLine,
    );
    expect(parsedCircular.msg.a).toBe(1);
    expect(parsedCircular.msg.self).toBe('[circular]');

    const parsedBigint = parseLine<{ msg: { n: string } }>(bigintLine);
    expect(parsedBigint.msg.n).toBe('10');
  });

  // A `WeakSet` of "everything visited anywhere" flags the *same* object
  // reachable twice through two unrelated branches (the same provider
  // descriptor in two arms of a router chain, say) as circular, which it
  // is not — nothing about serialising it once under `primary` and,
  // separately, again under `fallback` ever revisits it while already
  // inside it. Correct cycle detection needs the ancestor *path*, not the
  // set of every value seen so far; this is the twin of the genuinely
  // circular case above; the two are proven together.
  it('does not flag a repeated-but-acyclic reference as circular', () => {
    const shared = { model: 'gpt-4.1-mini', provider: 'openai' };

    logger.log({ primary: shared, fallback: shared });

    const [line] = stdout.lines();
    const parsed = parseLine<{
      msg: { primary: unknown; fallback: unknown };
    }>(line);
    expect(parsed.msg.primary).toEqual(shared);
    expect(parsed.msg.fallback).toEqual(shared);
  });

  // Past what the replacer can pre-empt: a getter that throws the moment
  // JSON.stringify reads the property, before the replacer ever sees a
  // value to convert. The outer catch is what stands behind that — still
  // one line, still valid JSON, still says logging itself failed rather
  // than vanishing or taking the process down. And it carries the
  // `context`/`requestId` already known at that point — the one line
  // produced when logging itself broke must not also be the one line in
  // the stream that cannot be correlated to a request.
  it('falls back to a safe line carrying context and requestId, never a thrown exception, for a value the replacer cannot pre-empt', () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get(): never {
        throw new Error('getter exploded');
      },
    });

    requestContext.run({ requestId: 'req-fallback' }, () => {
      expect(() => logger.log(hostile, 'HostileContext')).not.toThrow();
    });

    expect(stdout.spy).toHaveBeenCalledTimes(1);
    const [line] = stdout.lines();
    const parsed = parseLine<{
      msg: unknown;
      context?: string;
      requestId?: string;
    }>(line);
    expect(typeof parsed.msg).toBe('string');
    expect(String(parsed.msg)).toContain('failed to serialise');
    expect(parsed.context).toBe('HostileContext');
    expect(parsed.requestId).toBe('req-fallback');
  });

  // Not wired to an environment variable by this task, but the
  // LoggerService contract is honoured: a level below the configured floor
  // is suppressed, and the default (nothing configured) is unchanged —
  // every level still emits, so this cannot regress a caller that never
  // touches setLogLevels at all.
  describe('setLogLevels', () => {
    it('suppresses levels below the configured floor and keeps the rest', () => {
      logger.setLogLevels(['warn']);

      logger.debug('suppressed');
      logger.log('suppressed');
      logger.warn('kept');
      logger.error('kept');
      logger.fatal('kept');

      expect(stdout.spy).not.toHaveBeenCalled();
      expect(stderr.spy).toHaveBeenCalledTimes(3);
    });

    it('defaults to every level enabled when never configured', () => {
      logger.verbose('kept');
      logger.debug('kept');

      expect(stdout.spy).toHaveBeenCalledTimes(2);
    });

    // Discriminates the two possible readings of a non-contiguous
    // configuration, which a single-level or already-contiguous set
    // cannot: Nest's own isLogLevelEnabled floors on the *highest*
    // configured severity, so ['log', 'error'] enables {log, error,
    // fatal} — 'warn' stays suppressed even though its own severity sits
    // between the two configured levels. A lowest-severity reading would
    // wrongly enable 'warn' too (its severity is above 'log's), which is
    // exactly the bug this test exists to catch.
    it('floors on the highest configured level, matching Nest, not the lowest', () => {
      logger.setLogLevels(['log', 'error']);

      logger.log('kept — explicitly configured');
      logger.warn('suppressed — between the two configured levels');
      logger.error('kept — explicitly configured');
      logger.fatal('kept — above the highest configured level');

      expect(stdout.spy).toHaveBeenCalledTimes(1);
      expect(stderr.spy).toHaveBeenCalledTimes(2);
    });
  });
});
