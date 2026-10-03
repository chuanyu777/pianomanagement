import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { currentPeriod } from '../../common/period.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { OverviewQueryDto } from './dto/overview-query.dto.js';
import { OverviewService } from './overview.service.js';

/**
 * 经营总览（US-OV-01…04）。整块只对店主开放。
 *
 * 一次返回四块，controller 只做组装与转发；四块的计算在 service 里。
 */
@Controller('overview')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  async getOverview(@Query() query: OverviewQueryDto) {
    const period = query.period ?? currentPeriod();
    const [cards, composition, trend, profitShare] = await Promise.all([
      this.overview.buildCards(period),
      this.overview.buildComposition(period),
      this.overview.buildProfitTrend(period),
      this.overview.buildProfitShare(period),
    ]);
    return { period, cards, composition, trend, profitShare };
  }
}
