import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { InternalToolsController } from './internal-tools.controller.js';
import { InternalToolsService } from './internal-tools.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [InternalToolsController],
  providers: [InternalToolsService],
})
export class InternalToolsModule {}
