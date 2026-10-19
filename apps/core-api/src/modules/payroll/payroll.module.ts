import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PeriodsModule } from '../periods/periods.module.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';
@Module({ imports: [PrismaModule, PeriodsModule], controllers: [PayrollController], providers: [PayrollService], exports: [PayrollService] })
export class PayrollModule {}
