import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { CoursesController } from './courses.controller.js';
import { CoursesService } from './courses.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [CoursesController],
  providers: [CoursesService],
  exports: [CoursesService],
})
export class CoursesModule {}
