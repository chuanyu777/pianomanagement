import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { CourseLedgerController } from './course-ledger.controller.js';
import { CourseLedgerService } from './course-ledger.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [CourseLedgerController],
  providers: [CourseLedgerService],
  exports: [CourseLedgerService],
})
export class CourseLedgerModule {}
