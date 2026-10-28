import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { parseBusinessMonth } from '../../common/time/business-calendar.js';
import { UserRole, type ManualExpenseCategory, type ManualIncomeCategory, type PaymentChannel } from '../../generated/prisma/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ReportsService, type CashFlowItem, type CashFlowReport, type MonthlyReport } from './reports.service.js';
class MonthlyReportResponse implements MonthlyReport { @ApiProperty({ type: String, format: 'date-time' }) periodStart!: Date; @ApiProperty({ type: String }) cashIncome!: string; @ApiProperty({ type: String }) cashExpense!: string; @ApiProperty({ type: String }) cashNet!: string; @ApiProperty({ type: String }) lessonIncome!: string; @ApiProperty({ type: String }) refundFeeIncome!: string; @ApiProperty({ type: String }) manualIncome!: string; @ApiProperty({ type: String }) payrollCost!: string; @ApiProperty({ type: String }) giftCost!: string; @ApiProperty({ type: String }) manualExpense!: string; @ApiProperty({ type: String }) operatingExpense!: string; @ApiProperty({ type: String }) operatingProfit!: string; }
class CashFlowReversalResponse {
  @ApiProperty({ type: String }) ledgerEntryId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: Date;
}
class CashFlowItemResponse implements CashFlowItem {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ enum: ['PAYMENT', 'REFUND', 'PAYROLL', 'MANUAL_INCOME', 'MANUAL_EXPENSE'] }) type!: CashFlowItem['type'];
  @ApiProperty({ enum: ['INCOME', 'EXPENSE'] }) direction!: CashFlowItem['direction'];
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: Date;
  @ApiProperty({ type: String, example: '120.00' }) amount!: string;
  @ApiProperty({ type: String, nullable: true }) channel!: PaymentChannel | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, nullable: true }) counterparty!: string | null;
  @ApiProperty({ type: String, nullable: true }) category!: ManualIncomeCategory | ManualExpenseCategory | null;
  @ApiProperty({ type: CashFlowReversalResponse, required: false }) reversal?: CashFlowReversalResponse;
  @ApiProperty({ type: String, required: false, example: '10.00' }) feeAmount?: string;
  @ApiProperty({ type: String, required: false, example: '100.00' }) totalPaidRefund?: string;
}
class CashFlowReportResponse implements CashFlowReport {
  @ApiProperty({ enum: ['DAY', 'MONTH'] }) periodType!: 'DAY' | 'MONTH';
  @ApiProperty({ type: String, example: '2026-10-27' }) period!: string;
  @ApiProperty({ type: String, format: 'date-time' }) rangeStart!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) rangeEnd!: Date;
  @ApiProperty({ type: String, example: '100.00' }) cashIncome!: string;
  @ApiProperty({ type: String, example: '50.00' }) cashExpense!: string;
  @ApiProperty({ type: String, example: '50.00' }) cashNet!: string;
  @ApiProperty({ type: CashFlowItemResponse, isArray: true }) items!: CashFlowItemResponse[];
}
@ApiTags('Reports') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.OWNER) @Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('monthly')
  @ApiOkResponse({ type: MonthlyReportResponse })
  monthly(@Query('period') period?: string): Promise<MonthlyReport> {
    const month = period ? parseBusinessMonth(period) : null;
    if (!month) throw new BadRequestException('月份格式应为 YYYY-MM');
    return this.reports.monthly(month);
  }

  @Get('cash-flow')
  @ApiQuery({ name: 'date', required: false, type: String, description: '业务日期 YYYY-MM-DD；与 period 二选一' })
  @ApiQuery({ name: 'period', required: false, type: String, description: '业务月份 YYYY-MM；与 date 二选一' })
  @ApiOkResponse({ type: CashFlowReportResponse })
  cashFlow(@Query('date') date?: string, @Query('period') period?: string): Promise<CashFlowReport> {
    if (Boolean(date) === Boolean(period)) throw new BadRequestException('请且仅选择一个业务日期或月份');
    if (date) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      if (!match) throw new BadRequestException('日期格式应为 YYYY-MM-DD');
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const utcDay = Date.UTC(year, month - 1, day);
      const parsed = new Date(utcDay);
      if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new BadRequestException('日期格式应为 YYYY-MM-DD');
      const start = new Date(utcDay - 8 * 60 * 60 * 1000);
      return this.reports.cashFlow({ periodType: 'DAY', period: date, range: { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) } });
    }
    const monthStart = period ? parseBusinessMonth(period) : null;
    if (!monthStart || !period) throw new BadRequestException('月份格式应为 YYYY-MM');
    const offset = 8 * 60 * 60 * 1000;
    const range = {
      start: new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1) - offset),
      end: new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1) - offset),
    };
    return this.reports.cashFlow({ periodType: 'MONTH', period, range });
  }
}
