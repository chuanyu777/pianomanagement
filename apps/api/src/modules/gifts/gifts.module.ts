import { Module } from '@nestjs/common';
import { PeriodsModule } from '../periods/periods.module.js';
import { GiftsController } from './gifts.controller.js';
import { GiftsService } from './gifts.service.js';

/**
 * 赠送模块（US-GL-01/02/03）。
 *
 * 只依赖 PeriodsModule（建赠 / 撤销前校验归属月份未关账）。
 * **不 import lessons 模块**：剩余额度直接用 prisma.lesson.count 算，
 * 这是最容易写出循环依赖的地方（lessons 也要读 giftGrant）。
 */
@Module({
  imports: [PeriodsModule],
  controllers: [GiftsController],
  providers: [GiftsService],
  exports: [GiftsService],
})
export class GiftsModule {}
