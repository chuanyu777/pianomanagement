import { Module } from '@nestjs/common';
import { PeriodsModule } from '../periods/periods.module.js';
import { LessonsController } from './lessons.controller.js';
import { LessonsService } from './lessons.service.js';

/**
 * 排课与上课确认模块。
 *
 * 只依赖 PeriodsModule（确认 / 回冲前要校验目标月份未关账）——
 * 余额拆池直接调 ledger/balance.ts 的纯函数，**不 import 其它业务模块**，
 * 尤其不 import gifts：赠送额度只通过 prisma.giftGrant 读。
 */
@Module({
  imports: [PeriodsModule],
  controllers: [LessonsController],
  providers: [LessonsService],
  exports: [LessonsService],
})
export class LessonsModule {}
