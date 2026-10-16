import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AssistantActionsController } from './assistant-actions.controller.js';
import { AssistantActionsService } from './assistant-actions.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [AssistantActionsController],
  providers: [AssistantActionsService],
  exports: [AssistantActionsService],
})
export class AssistantActionsModule {}
