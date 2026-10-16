import { Global, Module } from '@nestjs/common';
import { InternalRequestGuard } from './internal-request.guard.js';

@Global()
@Module({
  providers: [InternalRequestGuard],
  exports: [InternalRequestGuard],
})
export class InternalRequestModule {}
