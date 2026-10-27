import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AssistantActionsController } from './assistant-actions.controller.js';
import { AssistantActionsService } from './assistant-actions.service.js';
import { AssistantPreviewConfirmController } from './assistant-actions.controller.js';
import { LessonsModule } from '../lessons/lessons.module.js';
import { CourseLedgerModule } from '../course-ledger/course-ledger.module.js';
import { RefundsModule } from '../refunds/refunds.module.js';
import { ManualTransactionsModule } from '../manual-transactions/manual-transactions.module.js';
import { PayrollModule } from '../payroll/payroll.module.js';
import { PeriodsModule } from '../periods/periods.module.js';
import { InternalRequestModule } from '../../common/internal-auth/internal-request.module.js';
import { StudentsModule } from '../students/students.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { StudentCourseAccountsModule } from '../student-course-accounts/student-course-accounts.module.js';
import { TeachersModule } from '../teachers/teachers.module.js';

@Module({
  imports: [PrismaModule, InternalRequestModule, LessonsModule, CourseLedgerModule, RefundsModule, ManualTransactionsModule, PayrollModule, PeriodsModule, StudentsModule, CoursesModule, StudentCourseAccountsModule, TeachersModule],
  controllers: [AssistantActionsController, AssistantPreviewConfirmController],
  providers: [AssistantActionsService],
  exports: [AssistantActionsService],
})
export class AssistantActionsModule {}
