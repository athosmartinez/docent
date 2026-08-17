import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import {
  MS_PER_MINUTE,
  throttleLimits,
} from '../common/throttling/throttling.module';
import { ingestRequestSchema } from './dto/ingest-request.dto';
import { IngestionRepository } from './ingestion.repository';
import { IngestionService } from './ingestion.service';

// Exported for the same reason ask.controller.ts exports ASK_THROTTLE: a
// unit test can pin the window this applies over without booting the app.
export const INGEST_THROTTLE = {
  default: {
    limit: () => throttleLimits.ingestPerMinute,
    ttl: MS_PER_MINUTE,
  },
};

@Controller()
export class IngestionController {
  // See IngestionService's constructor for why these are explicitly
  // @Inject()-ed instead of left to implicit type-based resolution.
  constructor(
    @Inject(IngestionService) private readonly service: IngestionService,
    @Inject(IngestionRepository)
    private readonly repository: IngestionRepository,
  ) {}

  @Post('ingest')
  @HttpCode(202)
  // Tighter than the default limit because a single call spends embeddings
  // for an entire source and holds a lease for the duration of the run.
  @Throttle(INGEST_THROTTLE)
  async ingest(
    @Body() body: unknown,
  ): Promise<{ sourceId: string; status: string }> {
    const parsed = ingestRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
      );
    }

    return this.service.startIngestion(parsed.data.source, parsed.data.include);
  }

  @Get('sources')
  listSources() {
    return this.repository.listSources();
  }

  @Get('sources/:id')
  async getSource(@Param('id', ParseUUIDPipe) id: string) {
    const source = await this.repository.findSource(id);

    if (!source) {
      throw new NotFoundException(`no source with id ${id}`);
    }

    return source;
  }

  @Delete('sources/:id')
  @HttpCode(204)
  async deleteSource(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.repository.deleteSource(id);
  }
}
