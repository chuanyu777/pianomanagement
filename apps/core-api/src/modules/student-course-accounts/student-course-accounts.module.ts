import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { StudentCourseAccountsController } from './student-course-accounts.controller.js';
import { StudentCourseAccountsService } from './student-course-accounts.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [StudentCourseAccountsController],
  providers: [StudentCourseAccountsService],
  exports: [StudentCourseAccountsService],
})
export class StudentCourseAccountsModule {}
