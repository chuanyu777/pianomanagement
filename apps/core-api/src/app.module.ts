import { Module } from '@nestjs/common';
import { CapabilityModule } from './common/capability/capability.module.js';
import { InternalRequestModule } from './common/internal-auth/internal-request.module.js';
import { AssistantActionsModule } from './modules/assistant-actions/assistant-actions.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AssistantGatewayModule } from './modules/assistant-gateway/assistant-gateway.module.js';
import { AssistantStatusModule } from './modules/assistant-status/assistant-status.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { InternalToolsModule } from './modules/internal-tools/internal-tools.module.js';
import { CoursesModule } from './modules/courses/courses.module.js';
import { CourseLedgerModule } from './modules/course-ledger/course-ledger.module.js';
import { LessonsModule } from './modules/lessons/lessons.module.js';
import { ManualTransactionsModule } from './modules/manual-transactions/manual-transactions.module.js';
import { PeriodsModule } from './modules/periods/periods.module.js';
import { PayrollModule } from './modules/payroll/payroll.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { RefundsModule } from './modules/refunds/refunds.module.js';
import { StudentCourseAccountsModule } from './modules/student-course-accounts/student-course-accounts.module.js';
import { StudentsModule } from './modules/students/students.module.js';
import { TeachersModule } from './modules/teachers/teachers.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';

@Module({
  imports: [
    CapabilityModule,
    InternalRequestModule,
    AuthModule,
    AssistantActionsModule,
    AssistantGatewayModule,
    AssistantStatusModule,
    InternalToolsModule,
    CoursesModule,
    CourseLedgerModule,
    DashboardModule,
    LessonsModule,
    ManualTransactionsModule,
    PeriodsModule,
    PayrollModule,
    ReportsModule,
    RefundsModule,
    StudentsModule,
    StudentCourseAccountsModule,
    TeachersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
