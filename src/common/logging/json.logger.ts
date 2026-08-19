import type { LoggerService, LogLevel } from '@nestjs/common';

import { describeError } from '../describe-error';
import { currentRequestId } from './request-context';

interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly context?: string;
  readonly requestId?: string;
  readonly msg: unknown;
}

const ALL_LEVELS: LogLevel[] = [
  'verbose',
  'debug',
  'log',
  'warn',
  'error',
  'fatal',
];

// Ordinal severity, matching Nest's own LOG_LEVELS ordering — configuring a
// level enables it and everything more severe, not that level alone.
const LEVEL_SEVERITY: Record<LogLevel, number> = {
  verbose: 0,
  debug: 1,
  log: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/**
 * Nest's `LoggerService`, hand-written rather than pulled in from a
 * package — this repository already prefers a small owned helper
 * (`describeError`, `withTimeout`) to a dependency for exactly this shape of
 * problem, and this same milestone made the identical call for the
 * throttler's Redis storage.
 *
 * One JSON object per call, written in a single `process.stdout`/`stderr`
 * `write` ending in exactly one `\n`. That is what makes a log stream safe
 * to split into records by newline: every value in the object — the message
 * included — passes through `JSON.stringify`, which escapes a newline
 * inside a string into the two characters `\n` rather than emitting a real
 * line break. This service's SSE wire format depends on the identical
 * property for the identical reason (`JSON.stringify`ing every event's data
 * so no payload can contain a raw newline and corrupt frame parsing on the
 * client) — the reasoning is established elsewhere in this codebase, not
 * invented here.
 *
 * Nest calls a `LoggerService` the same way regardless of which one is
 * installed: `new Logger('SomeContext').warn('message')` always resolves to
 * a call shaped `warn(message, 'SomeContext')`. `error()` is the one method
 * with a richer, three-slot convention — `(message, stack?, context?)` —
 * and the stack *is* preserved here: it just never arrives as a literal
 * positional argument on any call site in this codebase (every one already
 * folds a caught error through `describeError` before logging), and Nest's
 * own internal exception handling passes the raw `Error` as `message`
 * instead of as a separate stack argument. Either shape's stack ends up in
 * `msg`, appended after the description — see `normalizeMessage` (an
 * Error-like *message*) and `parseErrorParams`/`isStackFormat` (a stack
 * passed as the *next* argument, Nest's own idiom for a caller that already
 * has one — `logger.error('handler blew up', err.stack)`).
 */
export class JsonLogger implements LoggerService {
  private enabledLevels: LogLevel[] = ALL_LEVELS;

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  /**
   * Not wired to an environment variable by this task — nothing here reads
   * a `LOG_LEVEL` setting — but the contract is honoured (defaulting to
   * every level enabled, today's behaviour) so a future caller, or Nest
   * itself when `NestFactory.create(AppModule, { logger: [...] })` names an
   * array of levels, can raise the threshold without this class silently
   * ignoring the request.
   */
  setLogLevels(levels: LogLevel[]): void {
    this.enabledLevels = levels;
  }

  private isLevelEnabled(level: LogLevel): boolean {
    if (this.enabledLevels.length === 0) {
      return false;
    }
    if (this.enabledLevels.includes(level)) {
      return true;
    }
    // Matches Nest's own isLogLevelEnabled exactly: the *highest* severity
    // among the configured levels is the floor, not the lowest. A
    // non-contiguous set like ['log', 'error'] therefore enables
    // {log, error, fatal} — not {log, warn, error, fatal}, which the
    // lowest-severity reading would have produced. Reimplemented rather
    // than imported: @nestjs/common exports LogLevel/LOG_LEVELS publicly
    // but not the isLogLevelEnabled utility itself.
    const highestConfigured = Math.max(
      ...this.enabledLevels.map((enabled) => LEVEL_SEVERITY[enabled]),
    );
    return LEVEL_SEVERITY[level] >= highestConfigured;
  }

  private write(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    const parsed =
      level === 'error'
        ? parseErrorParams(optionalParams)
        : parseNonErrorParams(optionalParams);

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      context: parsed.context,
      requestId: currentRequestId(),
      msg: buildMessage(message, parsed.stack, parsed.extras),
    };

    // Errors are read on a different channel than routine operation from
    // day one in most deployments (a collector that alerts on stderr, a
    // terminal that colours it) — matching Nest's own ConsoleLogger, which
    // makes the same split.
    const stream =
      level === 'error' || level === 'warn' || level === 'fatal'
        ? process.stderr
        : process.stdout;
    stream.write(`${safeStringify(record)}\n`);
  }
}

interface ParsedCall {
  readonly context: string | undefined;
  readonly stack: string | undefined;
  readonly extras: unknown[];
}

/** log/warn/debug/verbose/fatal: Nest's own convention is `(message, context?)`. */
function parseNonErrorParams(optionalParams: unknown[]): ParsedCall {
  const last = optionalParams[optionalParams.length - 1];
  const hasContext = typeof last === 'string';

  return {
    context: hasContext ? last : undefined,
    stack: undefined,
    extras: hasContext ? optionalParams.slice(0, -1) : optionalParams,
  };
}

/**
 * error(): Nest's own convention is `(message, stack?, context?)`. A single
 * trailing string is ambiguous between "no context, just a stack" and "no
 * stack, just a context" by position alone — resolved the same way Nest's
 * own `ConsoleLogger` resolves it (`getContextAndStackAndMessagesToPrint`):
 * by asking whether the string actually *looks* like a stack trace, not by
 * where it sits in the argument list.
 */
function parseErrorParams(optionalParams: unknown[]): ParsedCall {
  const rest = [...optionalParams];

  const last = rest[rest.length - 1];
  const context =
    typeof last === 'string' && !isStackFormat(last) ? last : undefined;
  if (context !== undefined) {
    rest.pop();
  }

  const candidateStack = rest[rest.length - 1];
  const stack = isStackFormat(candidateStack) ? candidateStack : undefined;
  if (stack !== undefined) {
    rest.pop();
  }

  return { context, stack, extras: rest };
}

/**
 * Matches Nest's own `ConsoleLogger.isStackFormat`: a real stack trace is
 * multi-line and its frames read `at <location>:<line>:<column>`, which no
 * class/context name a caller would pass instead ever does.
 */
function isStackFormat(value: unknown): value is string {
  return typeof value === 'string' && /^(.)+\n\s+at .+:\d+:\d+/.test(value);
}

/**
 * `JSON.stringify(someError)` reads only an `Error`'s own enumerable
 * properties — which on every JavaScript engine excludes `message` and
 * `stack` — so a raw exception logged as-is serialises to `{}`, silently
 * discarding the one thing worth logging. Nest's own global exception
 * handling does exactly this (`logger.error(exception)`, no
 * stringification first), so this is not a hypothetical call shape.
 * `describeError`'s realm-independent duck typing is what this repository
 * already uses everywhere else an error crosses into a log line or a
 * response; a hand-written logger is exactly where it matters most, since
 * there is no other layer left to catch what it drops.
 *
 * The duck type here (`.stack` is a string) is deliberately narrower than
 * `describeError`'s own — it exists to distinguish "this is an error" from
 * "this is a plain data object someone chose to log", which
 * `describeError`'s `message`/`code`/`errors` checks alone cannot do
 * (an ordinary object can have a `message` field for reasons that have
 * nothing to do with being an error). Almost nothing but a real `Error`
 * ever carries a `.stack` string.
 *
 * The stack itself — file, line, column — is appended after
 * `describeError`'s summary rather than discarded: `describeError` reads
 * only `.message`/`.code`/`.errors`, none of which is where V8 puts a
 * frame. Losing it here would mean the first genuine unhandled exception in
 * production yields a message and a request id and nowhere to look.
 */
function normalizeMessage(message: unknown): unknown {
  if (!isErrorLike(message)) {
    return message;
  }

  const description = describeError(message);
  const stack = errorStackOf(message);
  return stack ? `${description}\n${stack}` : description;
}

function isErrorLike(value: unknown): boolean {
  if (value instanceof Error) {
    return true;
  }

  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { stack?: unknown }).stack === 'string'
  );
}

function errorStackOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const stack = (value as { stack?: unknown }).stack;
  return typeof stack === 'string' && stack.length > 0 ? stack : undefined;
}

/**
 * Folds a stack (from either an Error-like *message*, via `normalizeMessage`
 * above, or an explicit stack *argument*, via `parseErrorParams`) into the
 * message text with a newline — safe under this format for the same reason
 * a message containing one is: every value here is JSON-encoded before it
 * ever reaches a stream, so an embedded newline stays inside one JSON
 * string, one line on the wire.
 *
 * `extras` — anything left over once context and stack are accounted for —
 * is a call shape no site in this codebase currently produces
 * (`logger.log('msg', { meta })`), but `LoggerService`'s own contract
 * allows it, and silently dropping it is worse than an unfamiliar shape: a
 * bare value when there is exactly one thing to say, `[msg, ...extras]`
 * when there is more, so nothing a caller passed simply vanishes.
 */
function buildMessage(
  message: unknown,
  stack: string | undefined,
  extras: unknown[],
): unknown {
  const described = normalizeMessage(message);
  const withStack =
    stack && typeof described === 'string'
      ? `${described}\n${stack}`
      : described;

  const meaningfulExtras = extras.filter((value) => value !== undefined);
  return meaningfulExtras.length > 0
    ? [withStack, ...meaningfulExtras]
    : withStack;
}

/**
 * A circular reference or a `BigInt` anywhere in a logged value would
 * otherwise throw inside `JSON.stringify` itself — and every call site of
 * this class is either ordinary request handling or, worse, an error
 * handler, where a second, unrelated exception thrown while trying to log
 * the first would replace the failure being reported with a crash instead
 * of a line describing it. Both are converted rather than merely caught, so
 * the common cases still produce a real, readable line; the `catch` below
 * exists for whatever this replacer does not anticipate (a throwing getter,
 * a hostile `toJSON`) — logging never goes silent, and never takes the
 * process down with it. That fallback line still carries the real
 * `context`/`requestId` already known from `record` — the one line in the
 * stream produced when logging itself broke is not also the one line in it
 * that cannot be correlated to a request.
 */
function safeStringify(record: LogRecord): string {
  try {
    return JSON.stringify(record, circularSafeReplacer());
  } catch (error: unknown) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      context: record.context,
      requestId: record.requestId,
      msg: `failed to serialise log record (level ${record.level}): ${describeError(error)}`,
    });
  }
}

/**
 * A `WeakSet` of "every object visited anywhere in this call" flags a
 * repeated-but-*non-circular* reference — the same object reachable twice
 * through two different, non-overlapping branches, such as the same
 * provider descriptor appearing in two arms of a router chain — as
 * `[circular]`, which it is not: nothing about visiting it once under one
 * key and, separately, again under another ever revisits it while already
 * inside it. Correct cycle detection needs the ancestor *path* to the value
 * currently being serialised, not the set of every value seen so far.
 *
 * `JSON.stringify` calls its replacer with `this` bound to the immediate
 * parent (the "holder") of the key being processed, and walks depth-first —
 * so the ancestor stack for the current call is always a prefix of the
 * previous call's. Popping every entry above `this` before checking
 * membership recovers exactly the current path. This is the same technique
 * MDN's own `JSON.stringify()` documentation gives for this problem; it
 * requires a non-arrow function specifically so `this` is the holder
 * `JSON.stringify` passes, not whatever `this` happened to be in scope
 * where the replacer was written.
 */
function circularSafeReplacer(): (
  this: unknown,
  key: string,
  value: unknown,
) => unknown {
  const ancestors: unknown[] = [];

  return function (this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }

    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) {
      return '[circular]';
    }
    ancestors.push(value);
    return value;
  };
}
