import { Module } from '@nestjs/common';
import { PeriodsModule } from '../periods/periods.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { RefundsController } from './refunds.controller.js';
import { RefundsRepository } from './refunds.repository.js';
import { RefundsService } from './refunds.service.js';

@Module({
  imports: [PrismaModule, PeriodsModule],
  controllers: [RefundsController],
  providers: [RefundsRepository, RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
