import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AssistantActionsController } from './assistant-actions.controller.js';
import { AssistantActionsService } from './assistant-actions.service.js';
import { AssistantPreviewConfirmController } from './assistant-actions.controller.js';
import { LessonsModule } from '../lessons/lessons.module.js';
import { CourseLedgerModule } from '../course-ledger/course-ledger.module.js';
import { RefundsModule } from '../refunds/refunds.module.js';

@Module({
  imports: [PrismaModule, LessonsModule, CourseLedgerModule, RefundsModule],
  controllers: [AssistantActionsController, AssistantPreviewConfirmController],
  providers: [AssistantActionsService],
  exports: [AssistantActionsService],
})
export class AssistantActionsModule {}
