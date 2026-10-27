import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { formatBusinessMonth, parseBusinessMonth } from '../../common/time/business-calendar.js';
import { UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { type ClosedPeriodSummary, PeriodsService, type PeriodCloseReadiness } from './periods.service.js';

class ClosePeriodBody {
  @ApiProperty({ type: String, example: '2026-10' })
  period!: string;
}

class ReopenPeriodBody extends ClosePeriodBody {
  @ApiProperty({ type: String, example: '补录遗漏的收支记录', minLength: 1, maxLength: 2000 })
  reason!: string;
}

class PeriodResponse {
  @ApiProperty({ type: String, example: '2026-10' })
  period!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  closedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reopenedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  reopenReason!: string | null;
}

class PeriodCloseReadinessResponse implements PeriodCloseReadiness {
  @ApiProperty({ type: String }) period!: string;
  @ApiProperty({ type: Boolean }) closed!: boolean;
  @ApiProperty({ type: Object, isArray: true }) blockers!: PeriodCloseReadiness['blockers'];
  @ApiProperty({ type: Object, isArray: true }) pendingLessons!: PeriodCloseReadiness['pendingLessons'];
  @ApiProperty({ type: Object, isArray: true }) missingPayrollTeachers!: PeriodCloseReadiness['missingPayrollTeachers'];
  @ApiProperty({ type: Object, isArray: true }) unpaidPayrolls!: PeriodCloseReadiness['unpaidPayrolls'];
  @ApiProperty({ type: Object, isArray: true }) refundAnomalies!: PeriodCloseReadiness['refundAnomalies'];
  @ApiProperty({ type: Object, isArray: true }) ledgerAnomalies!: PeriodCloseReadiness['ledgerAnomalies'];
}

const CloseSchema = z.object({ period: z.string() }).strict();
const ReopenSchema = z.object({ period: z.string(), reason: z.string().trim().min(1).max(2000) }).strict();

function actorId(request: AuthenticatedRequest): string {
  if (!request.actor) throw new BadRequestException('登录状态无效或已过期');
  return request.actor.id;
}

function summary(value: ClosedPeriodSummary): PeriodResponse {
  return { ...value, period: formatBusinessMonth(value.periodStart) };
}

@ApiTags('Periods')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@Controller('periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  @ApiOkResponse({ type: PeriodResponse, isArray: true })
  async list(): Promise<PeriodResponse[]> {
    return (await this.periods.list()).map(summary);
  }

  @Post('close')
  @ApiBody({ type: ClosePeriodBody })
  @ApiOkResponse({ type: PeriodResponse })
  async close(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<PeriodResponse> {
    const parsed = CloseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const periodStart = parseBusinessMonth(parsed.data.period);
    if (!periodStart) throw new BadRequestException('月份格式应为 YYYY-MM');
    return summary(await this.periods.close(periodStart, actorId(request)));
  }

  @Get('preclose')
  @ApiQuery({ name: 'period', required: true, type: String, example: '2026-10' })
  @ApiOkResponse({ type: PeriodCloseReadinessResponse })
  async preclose(@Query() query: unknown, @Req() _request: AuthenticatedRequest): Promise<PeriodCloseReadiness> {
    const parsed = z.object({ period: z.string() }).strict().safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const period = parseBusinessMonth(parsed.data.period);
    if (!period) throw new BadRequestException('月份格式应为 YYYY-MM');
    return this.periods.preclose(period);
  }

  @Post('reopen')
  @ApiBody({ type: ReopenPeriodBody })
  @ApiOkResponse({ type: PeriodResponse })
  async reopen(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<PeriodResponse> {
    const parsed = ReopenSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const periodStart = parseBusinessMonth(parsed.data.period);
    if (!periodStart) throw new BadRequestException('请求参数不合法');
    return summary(await this.periods.reopen(periodStart, parsed.data.reason, actorId(request)));
  }
}
