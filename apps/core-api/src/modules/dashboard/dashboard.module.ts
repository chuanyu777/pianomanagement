import { Module } from '@nestjs/common';
import { LessonsModule } from '../lessons/lessons.module.js';
import { PeriodsModule } from '../periods/periods.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { StudentsModule } from '../students/students.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { DashboardRepository } from './dashboard.repository.js';

@Module({
  imports: [PrismaModule, LessonsModule, StudentsModule, ReportsModule, PeriodsModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardRepository],
})
export class DashboardModule {}
