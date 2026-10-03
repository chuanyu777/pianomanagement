import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PeriodsService } from './periods.service.js';

@Controller('periods')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get('closed')
  list() {
    return this.periods.listClosedPeriods();
  }

  @Post(':period/close')
  close(@Param('period') period: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.periods.close(period, actor.id);
  }

  @Post(':period/reopen')
  reopen(@Param('period') period: string) {
    return this.periods.reopen(period);
  }
}
