import { Module } from '@nestjs/common';
import { CourseTypesController } from './course-types.controller.js';
import { CourseTypesService } from './course-types.service.js';

@Module({
  controllers: [CourseTypesController],
  providers: [CourseTypesService],
  exports: [CourseTypesService],
})
export class CourseTypesModule {}
