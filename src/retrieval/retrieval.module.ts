import { Module } from '@nestjs/common';

import { RetrievalRepository } from './retrieval.repository';

@Module({
  providers: [RetrievalRepository],
  exports: [RetrievalRepository],
})
export class RetrievalModule {}
