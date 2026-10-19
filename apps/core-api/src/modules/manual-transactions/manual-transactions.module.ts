import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PeriodsModule } from '../periods/periods.module.js';
import { ManualTransactionsController } from './manual-transactions.controller.js';
import { ManualTransactionsService } from './manual-transactions.service.js';

@Module({
  imports: [PrismaModule, PeriodsModule],
  controllers: [ManualTransactionsController],
  providers: [ManualTransactionsService],
  exports: [ManualTransactionsService],
})
export class ManualTransactionsModule {}
