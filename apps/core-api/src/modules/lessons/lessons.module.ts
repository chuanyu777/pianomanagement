import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { LessonsController } from './lessons.controller.js';
import { LessonsRepository } from './lessons.repository.js';
import { LessonsService } from './lessons.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [LessonsController],
  providers: [LessonsRepository, LessonsService],
  exports: [LessonsService],
})
export class LessonsModule {}
