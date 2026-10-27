import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { InternalToolsController } from './internal-tools.controller.js';
import { InternalToolsService } from './internal-tools.service.js';
import { InternalRequestModule } from '../../common/internal-auth/internal-request.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { CourseLedgerModule } from '../course-ledger/course-ledger.module.js';
import { LessonsModule } from '../lessons/lessons.module.js';
import { StudentsModule } from '../students/students.module.js';
import { TeachersModule } from '../teachers/teachers.module.js';
import { CoursesModule } from '../courses/courses.module.js';

@Module({
  imports: [PrismaModule, InternalRequestModule, ReportsModule, LessonsModule, CourseLedgerModule, StudentsModule, TeachersModule, CoursesModule],
  controllers: [InternalToolsController],
  providers: [InternalToolsService],
})
export class InternalToolsModule {}
