import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PayrollPeriodQueryDto } from './dto/payroll-period-query.dto.js';
import { UpsertPayrollDto } from './dto/upsert-payroll.dto.js';
import {
  type MyPayroll,
  type OptionalPayrollColumn,
  type PayrollRow,
  PayrollService,
  type PayrollSheet,
  type PeriodTotalsResult,
  type RecomputeResult,
} from './payroll.service.js';

/**
 * 工资表。
 *
 * 整块默认只对店主开放；唯一例外是 `GET /payroll/me`（店主 + 授课老师），
 * 它靠 service 里的行级判断保证老师只能拿到自己那条。
 *
 * 两个 guard 缺一不可：JwtAuthGuard 管登录，RolesGuard 管角色。
 */
@Controller('payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class PayrollController {
  constructor(private readonly payrollService: PayrollService) {}

  /** US-PR-07：自己的工资与课时。老师与店主都可访问。 */
  @Get('me')
  @Roles(UserRole.OWNER, UserRole.TEACHER)
  getMine(
    @Query() query: PayrollPeriodQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MyPayroll> {
    return this.payrollService.getMine(actor, query.period);
  }

  /** US-PR-04：工资表可选列定义。 */
  @Get('columns')
  getColumns(): OptionalPayrollColumn[] {
    return this.payrollService.getColumns();
  }

  /** US-PR-05：两个口径。 */
  @Get('totals')
  getTotals(@Query() query: PayrollPeriodQueryDto): Promise<PeriodTotalsResult> {
    return this.payrollService.getTotals(query.period);
  }

  /** US-PR-01：工资表。 */
  @Get()
  getSheet(@Query() query: PayrollPeriodQueryDto): Promise<PayrollSheet> {
    return this.payrollService.getSheet(query.period);
  }

  /** US-PR-03：按课时重算业绩（幂等，不写库）。 */
  @Post('recompute')
  recompute(@Query() query: PayrollPeriodQueryDto): Promise<RecomputeResult> {
    return this.payrollService.recompute(query.period);
  }

  /** US-PR-06：录入工资基础项。period 走 body。 */
  @Put(':teacherId')
  upsert(
    @Param('teacherId') teacherId: string,
    @Body() dto: UpsertPayrollDto,
  ): Promise<PayrollRow> {
    return this.payrollService.upsertEntry(teacherId, dto);
  }
}
