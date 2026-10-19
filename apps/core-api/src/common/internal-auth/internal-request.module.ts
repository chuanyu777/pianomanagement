import { Global, Module } from '@nestjs/common';
import { InternalRequestGuard } from './internal-request.guard.js';
import { PostgresInternalRequestReplayStore } from './replay-protector.js';

@Global()
@Module({
  providers: [PostgresInternalRequestReplayStore, InternalRequestGuard],
  exports: [InternalRequestGuard, PostgresInternalRequestReplayStore],
})
export class InternalRequestModule {}
