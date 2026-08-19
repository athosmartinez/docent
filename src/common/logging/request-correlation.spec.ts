import {
  ConsoleLogger,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
} from '@nestjs/common';
import type {
  INestApplication,
  MiddlewareConsumer,
  NestModule,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';

import { JsonLogger } from './json.logger';
import {
  REQUEST_ID_HEADER,
  RequestIdMiddleware,
} from './request-id.middleware';

@Injectable()
class DeepService {
  private readonly logger = new Logger(DeepService.name);

  async doWork(): Promise<void> {
    // A real async gap — a macrotask, not just a microtask — between the
    // middleware assigning the request id and this logging it. Proves
    // AsyncLocalStorage's propagation survives an actual `await`, which a
    // purely synchronous call chain from middleware to handler would not
    // meaningfully exercise: that would look identical whether or not
    // propagation past an async boundary works at all.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.logger.log('deep work done');
  }
}

@Controller()
class ProbeController {
  constructor(private readonly deep: DeepService) {}

  @Get('probe')
  async probe(): Promise<{ ok: true }> {
    await this.deep.doWork();
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController], providers: [DeepService] })
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

interface DeepLogLine {
  msg: string;
  requestId?: string;
}

/**
 * Joins every link of the chain — middleware, AsyncLocalStorage, JsonLogger
 * — through one real HTTP request against a real, minimal Nest app, rather
 * than each proven separately by a different suite with nothing joining
 * them (the way an earlier task in this milestone shipped a three-link
 * chain that way and only found the gap in review).
 */
describe('request id correlation, end to end through a real Nest app', () => {
  let app: INestApplication<Server>;
  let written: string[];
  let stdoutSpy: jest.SpyInstance;

  beforeEach(async () => {
    written = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(chunk.toString());
        return true;
      });

    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useLogger(new JsonLogger());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    stdoutSpy.mockRestore();
    // app.useLogger installs a *process-wide* static logger (Nest's own
    // Logger.overrideLogger, not scoped to this app instance), and
    // app.close() does not revert it — left alone, every later spec file
    // this Jest worker happens to run afterwards would keep emitting JSON
    // through this test's now-closed logger instead of Nest's normal
    // console output.
    Logger.overrideLogger(new ConsoleLogger());
  });

  function deepLogLine(): DeepLogLine | undefined {
    return written
      .map((line) => JSON.parse(line) as DeepLogLine)
      .find((record) => record.msg === 'deep work done');
  }

  it('a log line emitted after an async boundary deep in the handler carries the same id the response echoed', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe')
      .expect(200);

    const headerId = response.headers[REQUEST_ID_HEADER];
    expect(typeof headerId).toBe('string');
    expect(deepLogLine()?.requestId).toBe(headerId);
  });

  it('an inbound x-request-id is echoed and reaches the same deep log line, not replaced by a generated one', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe')
      .set(REQUEST_ID_HEADER, 'client-supplied-id')
      .expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).toBe('client-supplied-id');
    expect(deepLogLine()?.requestId).toBe('client-supplied-id');
  });
});
