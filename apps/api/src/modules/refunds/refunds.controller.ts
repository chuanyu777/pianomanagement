import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateRefundDto } from './dto/create-refund.dto.js';
import { ListRefundsQueryDto } from './dto/list-refunds.dto.js';
import { RefundsService } from './refunds.service.js';

/** 流失名单 / 退费 / 保留余额（US-RF-01/02/03）。整块只对店主开放。 */
@Controller('refunds')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  list(@Query() query: ListRefundsQueryDto) {
    return this.refunds.list(query);
  }

  /** 待处理流失学生。静态路由与根路由不冲突，放前面更直观。 */
  @Get('pending-losses')
  pendingLosses() {
    return this.refunds.listPendingLosses();
  }

  @Post()
  create(@Body() dto: CreateRefundDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.refunds.create(dto, actor);
  }
}
