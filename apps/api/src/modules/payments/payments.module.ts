import { Module } from '@nestjs/common';
import { PeriodsModule } from '../periods/periods.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

/**
 * 交费记账模块。
 *
 * 只依赖 PeriodsModule（记账前校验归属月份未关账）。
 * 余额拆池直接调 ledger/balance.ts 的纯函数，**不 import 其它业务模块**；
 * 收入项校验直接读 prisma.incomeItem，不 import items 模块，避免反向依赖。
 */
@Module({
  imports: [PeriodsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
