import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';

/**
 * 收支项目清单（US-BD-08）。无外部依赖 —— 删除引用检查直接走 prisma 计数。
 * finance / payments / payroll 等模块只通过 Prisma 读这些清单，不 import 本模块。
 */
@Module({
  controllers: [ItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
