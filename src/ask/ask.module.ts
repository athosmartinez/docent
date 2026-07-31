import { Module } from '@nestjs/common';

import { AskRepository } from './ask.repository';

@Module({
  providers: [AskRepository],
  exports: [AskRepository],
})
export class AskModule {}
