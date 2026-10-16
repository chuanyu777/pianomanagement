import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { TeachersController } from './teachers.controller.js';
import { TeachersService } from './teachers.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [TeachersController],
  providers: [TeachersService],
  exports: [TeachersService],
})
export class TeachersModule {}
