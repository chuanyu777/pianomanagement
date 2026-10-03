import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * 健康检查。
 *
 * **故意**只探测数据库连通性，不查任何业务表 ——
 * 一旦探测逻辑依赖业务数据，业务数据异常就会被误报成「服务挂了」，
 * 探活就失去意义了。
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ status: 'ok'; database: 'up' }> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'up' };
  }
}
