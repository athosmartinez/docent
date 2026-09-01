import { Module } from '@nestjs/common';

import { CostController } from './cost.controller';
import { CostRepository } from './cost.repository';

@Module({
  controllers: [CostController],
  providers: [CostRepository],
  exports: [CostRepository],
})
export class CostModule {}
