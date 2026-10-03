import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { validateEnv } from './config/env.validation.js';
import { HealthModule } from './health/health.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CourseTypesModule } from './modules/course-types/course-types.module.js';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module.js';
import { FinanceModule } from './modules/finance/finance.module.js';
import { GiftsModule } from './modules/gifts/gifts.module.js';
import { ItemsModule } from './modules/items/items.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { LessonsModule } from './modules/lessons/lessons.module.js';
import { OnboardingModule } from './modules/onboarding/onboarding.module.js';
import { OrganizationModule } from './modules/organization/organization.module.js';
import { OverviewModule } from './modules/overview/overview.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PayrollModule } from './modules/payroll/payroll.module.js';
import { PeriodsModule } from './modules/periods/periods.module.js';
import { RefundsModule } from './modules/refunds/refunds.module.js';
import { RisksModule } from './modules/risks/risks.module.js';
import { StudentsModule } from './modules/students/students.module.js';
import { TeachersModule } from './modules/teachers/teachers.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

/**
 * 应用根模块。
 *
 * 模块清单按依赖层次排列，方便对照 docs/superpowers/plans 里的分层图：
 *   基建（prisma / periods / organization）
 *     → 基础资料（course-types / teachers / students / enrollments / items）
 *       → 业务（lessons / payments / gifts / refunds）
 *         → 报表（payroll / finance / overview / analytics / risks）
 *           → 编排（onboarding）
 * 新增模块请插在对应层次，不要把顺序打乱 —— 顺序本身是给人读的文档。
 *
 * 注意：Order matters for readability, not for DI — Nest 会自己解析依赖图。
 * 但 `onboarding` 依赖最多的 service，放最后。
 */
@Module({
  imports: [
    // 环境变量校验放在最前面：配置不对就别启动，宁可起不来也别带病上线
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),

    // 基础设施
    PrismaModule,
    PeriodsModule,
    OrganizationModule,
    HealthModule,

    // 账号与鉴权
    AuthModule,
    UsersModule,

    // 基础资料
    CourseTypesModule,
    TeachersModule,
    StudentsModule,
    EnrollmentsModule,
    ItemsModule,

    // 业务主流程
    LessonsModule,
    PaymentsModule,
    GiftsModule,
    RefundsModule,

    // 报表与分析
    LedgerModule,
    PayrollModule,
    FinanceModule,
    OverviewModule,
    AnalyticsModule,
    RisksModule,

    // 编排（初始化向导）
    OnboardingModule,
  ],
  providers: [
    // 用 APP_FILTER 注册而不是 app.useGlobalFilters()：
    // 前者能走依赖注入，后者只能手动 new，以后过滤器要注入东西就得返工
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
