import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { currentPeriod } from '../../common/period.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { AnalyticsService } from './analytics.service.js';
import { RankingQueryDto, TrendQueryDto } from './dto/analytics-query.dto.js';

/**
 * 经营分析（US-AN-01 / AN-02 / AN-03）。整块只对店主开放（权限矩阵 §8）。
 * controller 只做绑定与转发，排序与名次全在 service。
 */
@Controller('analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('teacher-ranking')
  teacherRanking(@Query() query: RankingQueryDto) {
    return this.analytics.teacherRanking(query.period ?? currentPeriod());
  }

  @Get('teacher-trend')
  teacherTrend(@Query() query: TrendQueryDto) {
    return this.analytics.teacherTrend(query.period ?? currentPeriod(), query.months);
  }

  @Get('student-ranking')
  studentRanking(@Query() query: RankingQueryDto) {
    return this.analytics.studentRanking(query.period ?? currentPeriod());
  }
}
