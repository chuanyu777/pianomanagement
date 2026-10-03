import { Module } from '@nestjs/common';
import { PeriodsController } from './periods.controller.js';
import { PeriodsService } from './periods.service.js';

@Module({
  controllers: [PeriodsController],
  providers: [PeriodsService],
  exports: [PeriodsService],
})
export class PeriodsModule {}
