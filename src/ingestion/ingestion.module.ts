import { Module } from '@nestjs/common';

import { IngestionController } from './ingestion.controller';
import { IngestionRepository } from './ingestion.repository';
import { IngestionService } from './ingestion.service';

@Module({
  controllers: [IngestionController],
  providers: [IngestionService, IngestionRepository],
  exports: [IngestionService],
})
export class IngestionModule {}
