import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AssistantStatusController } from './assistant-status.controller.js';
import { AssistantStatusService } from './assistant-status.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [AssistantStatusController],
  providers: [AssistantStatusService],
})
export class AssistantStatusModule {}
