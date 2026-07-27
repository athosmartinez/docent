import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { ingestRequestSchema } from './dto/ingest-request.dto';
import { IngestionRepository } from './ingestion.repository';
import { IngestionService } from './ingestion.service';

@Controller()
export class IngestionController {
  constructor(
    private readonly service: IngestionService,
    private readonly repository: IngestionRepository,
  ) {}

  @Post('ingest')
  @HttpCode(202)
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
