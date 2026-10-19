import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PeriodsController } from './periods.controller.js';
import { PeriodsService } from './periods.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [PeriodsController],
  providers: [PeriodsService],
  exports: [PeriodsService],
})
export class PeriodsModule {}
