import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreatePaymentDto } from './dto/create-payment.dto.js';
import { ListPaymentsQueryDto } from './dto/list-payments.dto.js';
import { PaymentsService } from './payments.service.js';

/** 交费记账（US-ML-02）。整块只对店主开放（§8 权限矩阵：学生余额台账仅店主）。 */
@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@Query() query: ListPaymentsQueryDto) {
    return this.payments.list(query);
  }

  @Post()
  create(@Body() dto: CreatePaymentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.create(dto, actor);
  }
}
