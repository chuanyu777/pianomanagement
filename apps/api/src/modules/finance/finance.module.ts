import { Module } from '@nestjs/common';
import { PeriodsModule } from '../periods/periods.module.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';

/**
 * 收支（US-IE-01~04）。
 *
 * 只依赖 PeriodsModule（其它支出 / 手工补录的归属月份要过关账校验）。
 * 工资口径走 payroll 的 `computePeriodTotals`（函数级 import，不 import PayrollModule），
 * 保证 finance → payroll 单向依赖，payroll 绝不反向 import finance。
 */
@Module({
  imports: [PeriodsModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
