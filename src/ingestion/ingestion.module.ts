import { Module } from '@nestjs/common';

import { IngestionController } from './ingestion.controller';
import { IngestionRepository } from './ingestion.repository';
import {
  DEFAULT_INGESTION_LEASE_CONFIG,
  INGESTION_LEASE_CONFIG,
  IngestionService,
} from './ingestion.service';

@Module({
  controllers: [IngestionController],
  providers: [
    IngestionService,
    IngestionRepository,
    {
      provide: INGESTION_LEASE_CONFIG,
      useValue: DEFAULT_INGESTION_LEASE_CONFIG,
    },
  ],
  exports: [IngestionService],
})
export class IngestionModule {}
