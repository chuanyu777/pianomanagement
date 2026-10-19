import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { InternalToolsController } from './internal-tools.controller.js';
import { InternalToolsService } from './internal-tools.service.js';
import { InternalRequestModule } from '../../common/internal-auth/internal-request.module.js';
import { ReportsModule } from '../reports/reports.module.js';

@Module({
  imports: [PrismaModule, InternalRequestModule, ReportsModule],
  controllers: [InternalToolsController],
  providers: [InternalToolsService],
})
export class InternalToolsModule {}
