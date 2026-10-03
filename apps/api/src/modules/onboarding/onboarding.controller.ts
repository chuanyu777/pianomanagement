import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CarryOverDto } from './dto/carry-over.dto.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * 初始化向导（US-IW-01 / US-IW-02）。整块仅店主可见。
 *
 * 状态查询这里也保持 OWNER-only：向导本身就是店主专属操作，
 * 没有让授课老师看到「首月接续数据录到哪了」的场景；放开只会多一条越权面。
 */
@Controller('onboarding')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('status')
  getStatus() {
    return this.onboarding.getStatus();
  }

  @Post('complete')
  complete() {
    return this.onboarding.complete();
  }

  @Put('carry-over')
  carryOver(@Body() dto: CarryOverDto) {
    return this.onboarding.carryOver(dto);
  }
}
