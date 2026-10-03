import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * 全局模块：任何模块要注入 PrismaService 都不用再 import 一遍。
 * PrismaService 内部已经管好了连接的建立与释放，业务模块不需要自己处理。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
