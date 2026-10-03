import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';

/**
 * 台账查询模块（US-ML-01）。
 *
 * 只读，不写流水，所以不依赖 PeriodsModule（关账保护只对写入口有意义）。
 * 余额计算直接调同目录的 `balance.ts`，PrismaService 由全局 PrismaModule 提供。
 */
@Module({
  controllers: [LedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
