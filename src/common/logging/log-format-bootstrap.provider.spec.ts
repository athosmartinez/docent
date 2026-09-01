import { ConsoleLogger, Logger, type LogLevel } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema';
import { LogFormatBootstrap } from './log-format-bootstrap.provider';

function fakeConfig(logFormat: 'json' | 'pretty'): ConfigService<Env, true> {
  return { get: () => logFormat } as unknown as ConfigService<Env, true>;
}

/**
 * `Logger.logLevels` has no public setter beyond `overrideLogger(array)`,
 * which sets it, never clears it — and it is not touched by
 * `overrideLogger(instance)` (the object form) at all, so a test in this
 * file that configures a threshold would otherwise leak it into every
 * later test, including ones asserting the *unconfigured* default. Reset
 * through the same narrow cast the production code reads it through.
 */
function resetGlobalLevels(): void {
  (Logger as unknown as { logLevels?: LogLevel[] }).logLevels = undefined;
}

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

describe('LogFormatBootstrap', () => {
  afterEach(() => {
    // Whatever a test above left the static logger as, every other test in
    // this file (and, in a real Jest worker, this one spec file's own
    // module registry) needs Nest's ordinary default back — a file-local
    // concern, not this class's own responsibility; see its own comment
    // for why it no longer restores anything itself.
    Logger.overrideLogger(new ConsoleLogger());
    resetGlobalLevels();
  });

  describe('installing the logger', () => {
    let overrideSpy: jest.SpyInstance;

    beforeEach(() => {
      overrideSpy = jest.spyOn(Logger, 'overrideLogger');
    });

    afterEach(() => {
      overrideSpy.mockRestore();
    });

    // Both branches of the same decision, in one test: a mutation that
    // hardcodes either outcome (always install, never install) fails
    // whichever half it contradicts.
    it('installs JsonLogger for json, and leaves the logger alone for pretty', () => {
      const bootstrap = new LogFormatBootstrap(fakeConfig('json'));
      bootstrap.onApplicationBootstrap();

      expect(overrideSpy).toHaveBeenCalledTimes(1);
      const [installed] = overrideSpy.mock.calls[0] as [unknown];
      expect(installed).toBeInstanceOf(Object);
      expect(
        (installed as { constructor: { name: string } }).constructor.name,
      ).toBe('JsonLogger');

      overrideSpy.mockClear();
      const prettyBootstrap = new LogFormatBootstrap(fakeConfig('pretty'));
      prettyBootstrap.onApplicationBootstrap();

      expect(overrideSpy).not.toHaveBeenCalled();
    });
  });

  // Real Logger.attachBuffer()/flush() — not mocked — since this proves a
  // mechanism (does flushing early actually stop a later call from being
  // silently buffered forever), not merely that flush() gets called.
  describe('flushing', () => {
    it('flushes the buffer built up before this hook runs, replaying it through the newly installed logger', () => {
      Logger.attachBuffer();
      new Logger('PreBoot').log('buffered before bootstrap');

      const stdout = capture(process.stdout);
      try {
        const bootstrap = new LogFormatBootstrap(fakeConfig('json'));
        bootstrap.onApplicationBootstrap();

        const replayed = stdout
          .lines()
          .find((line) => line.includes('buffered before bootstrap'));
        expect(replayed).toBeDefined();
        expect(() => {
          JSON.parse(replayed ?? '');
        }).not.toThrow();
      } finally {
        stdout.spy.mockRestore();
      }
    });

    // The actual defect this fixes: with bufferLogs: true and no early
    // flush, Nest's own auto-flush only fires inside listen()'s *success*
    // callback — so a boot failure between create() resolving and listen()
    // succeeding (a port already in use, say) discards every buffered
    // line, the one written to explain the crash included. Flushing here
    // detaches the buffer, so anything logged afterwards — the stand-in
    // for that later failure — reaches the stream immediately rather than
    // joining a buffer nothing will ever drain.
    it('detaches the buffer, so a failure logged after this hook runs is never silently buffered', () => {
      Logger.attachBuffer();

      const bootstrap = new LogFormatBootstrap(fakeConfig('json'));
      bootstrap.onApplicationBootstrap();

      const stderr = capture(process.stderr);
      try {
        new Logger('Bootstrap').error('EADDRINUSE: port already in use');

        expect(stderr.spy).toHaveBeenCalledTimes(1);
        const [line] = stderr.lines();
        expect(line).toContain('EADDRINUSE');
      } finally {
        stderr.spy.mockRestore();
      }
    });

    it('flushes even when LOG_FORMAT is pretty, so the same failure is not buffered under either format', () => {
      Logger.attachBuffer();

      const bootstrap = new LogFormatBootstrap(fakeConfig('pretty'));
      bootstrap.onApplicationBootstrap();

      const stderr = capture(process.stderr);
      try {
        new Logger('Bootstrap').error('EADDRINUSE: port already in use');
        expect(stderr.spy).toHaveBeenCalledTimes(1);
      } finally {
        stderr.spy.mockRestore();
      }
    });
  });

  describe('carrying a configured level threshold through', () => {
    it('applies a level threshold configured before this hook runs to the installed JsonLogger', () => {
      // The real, public entry point Nest itself uses to configure a
      // threshold (NestFactory.create(AppModule, { logger: [...] }) goes
      // through this same static call) — sets Logger.logLevels, the
      // protected field LogFormatBootstrap reads back.
      Logger.overrideLogger(['error']);

      const bootstrap = new LogFormatBootstrap(fakeConfig('json'));
      bootstrap.onApplicationBootstrap();

      const stdout = capture(process.stdout);
      const stderr = capture(process.stderr);
      try {
        new Logger('Probe').log('suppressed — below the configured threshold');
        new Logger('Probe').error('kept — at the configured threshold');

        expect(stdout.spy).not.toHaveBeenCalled();
        expect(stderr.spy).toHaveBeenCalledTimes(1);
      } finally {
        stdout.spy.mockRestore();
        stderr.spy.mockRestore();
      }
    });

    it('leaves every level enabled when nothing was ever configured', () => {
      const bootstrap = new LogFormatBootstrap(fakeConfig('json'));
      bootstrap.onApplicationBootstrap();

      const stdout = capture(process.stdout);
      try {
        new Logger('Probe').log('kept — no threshold was ever configured');
        expect(stdout.spy).toHaveBeenCalledTimes(1);
      } finally {
        stdout.spy.mockRestore();
      }
    });
  });
});
