import { Global, Module } from '@nestjs/common';

import { CacheService } from './cache.service';
import { CorpusVersion } from './corpus-version';

@Global()
@Module({
  providers: [CacheService, CorpusVersion],
  exports: [CacheService, CorpusVersion],
})
export class CacheModule {}
