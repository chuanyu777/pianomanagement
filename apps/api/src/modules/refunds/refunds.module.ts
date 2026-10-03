import { Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module.js';
import { PeriodsModule } from '../periods/periods.module.js';
import { RefundsController } from './refunds.controller.js';
import { RefundsService } from './refunds.service.js';

/**
 * 退费模块（US-RF-01/02/03）。
 *
 * 依赖 PeriodsModule（退费前校验归属月份未关账）与 OrganizationModule（读默认手续费率）。
 * 余额计算直接调 `../ledger/balance.js`，不 import LedgerService，避免多余耦合。
 */
@Module({
  imports: [PeriodsModule, OrganizationModule],
  controllers: [RefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
