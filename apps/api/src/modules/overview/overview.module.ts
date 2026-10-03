import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { OverviewController } from './overview.controller.js';
import { OverviewService } from './overview.service.js';

/**
 * 经营总览（US-OV-01…04）。
 *
 * 复用 finance 的收支口径（FinanceService）与 organization 的利润分配人。
 * 工资口径走 payroll 的函数级 import（computePayrollSheet），不 import PayrollModule，
 * 保持依赖单向：payroll → finance → overview。
 */
@Module({
  imports: [FinanceModule, OrganizationModule],
  controllers: [OverviewController],
  providers: [OverviewService],
  exports: [OverviewService],
})
export class OverviewModule {}
