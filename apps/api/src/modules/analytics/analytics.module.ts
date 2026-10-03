import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';

/**
 * 经营分析（US-AN-01 / AN-02 / AN-03）。
 *
 * 只读模块：业绩走 payroll 的函数级 import（computePayrollSheet），
 * 余额口径不涉及；PrismaService 由全局 PrismaModule 提供。
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
