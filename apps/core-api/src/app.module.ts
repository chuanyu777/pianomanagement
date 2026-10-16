import { Module } from '@nestjs/common';
import { CapabilityModule } from './common/capability/capability.module.js';
import { InternalRequestModule } from './common/internal-auth/internal-request.module.js';
import { AssistantActionsModule } from './modules/assistant-actions/assistant-actions.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AssistantGatewayModule } from './modules/assistant-gateway/assistant-gateway.module.js';
import { AssistantStatusModule } from './modules/assistant-status/assistant-status.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { InternalToolsController } from './modules/internal-tools/internal-tools.controller.js';
import { TeachersModule } from './modules/teachers/teachers.module.js';

@Module({
  imports: [
    CapabilityModule,
    InternalRequestModule,
    AuthModule,
    AssistantActionsModule,
    AssistantGatewayModule,
    AssistantStatusModule,
    TeachersModule,
  ],
  controllers: [HealthController, InternalToolsController],
})
export class AppModule {}
