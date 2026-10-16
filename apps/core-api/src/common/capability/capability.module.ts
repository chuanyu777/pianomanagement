import { Global, Module } from '@nestjs/common';
import { CapabilityGuard } from './capability.guard.js';
import { CapabilityTokenService } from './capability-token.service.js';

@Global()
@Module({
  providers: [CapabilityTokenService, CapabilityGuard],
  exports: [CapabilityTokenService, CapabilityGuard],
})
export class CapabilityModule {}
