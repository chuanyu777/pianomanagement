import { Module } from '@nestjs/common';
import { RisksController } from './risks.controller.js';
import { RisksService } from './risks.service.js';

/**
 * 风险提醒（US-RA-01 / US-RA-02）。
 *
 * 只读：余额走 ledger 的 `computeEnrollmentBalances` 函数级 import，
 * PrismaService 由全局 PrismaModule 提供。
 */
@Module({
  controllers: [RisksController],
  providers: [RisksService],
  exports: [RisksService],
})
export class RisksModule {}
