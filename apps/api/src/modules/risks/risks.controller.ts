import { Controller, Get, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RisksService } from './risks.service.js';

/**
 * 风险提醒（US-RA-01 / US-RA-02）。
 *
 * 权限（矩阵 §8）：欠费名单仅店主；**沉睡名单店主与授课老师都可见**（需求明确）。
 * 两个 guard 必须同时挂 —— 只挂 RolesGuard 时默认放行，@Roles 形同虚设。
 */
@Controller('risks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RisksController {
  constructor(private readonly risks: RisksService) {}

  @Get('unpaid')
  @Roles(UserRole.OWNER)
  listUnpaid() {
    return this.risks.listUnpaid();
  }

  @Get('sleeping')
  @Roles(UserRole.OWNER, UserRole.TEACHER)
  listSleeping() {
    return this.risks.listSleeping();
  }
}
