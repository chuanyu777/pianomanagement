import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { parseBusinessMonth } from '../../common/time/business-calendar.js';
import { UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ReportsService, type MonthlyReport } from './reports.service.js';
class MonthlyReportResponse implements MonthlyReport { @ApiProperty({ type: String, format: 'date-time' }) periodStart!: Date; @ApiProperty({ type: String }) cashIncome!: string; @ApiProperty({ type: String }) cashExpense!: string; @ApiProperty({ type: String }) cashNet!: string; @ApiProperty({ type: String }) lessonIncome!: string; @ApiProperty({ type: String }) refundFeeIncome!: string; @ApiProperty({ type: String }) manualIncome!: string; @ApiProperty({ type: String }) payrollCost!: string; @ApiProperty({ type: String }) giftCost!: string; @ApiProperty({ type: String }) manualExpense!: string; @ApiProperty({ type: String }) operatingProfit!: string; }
@ApiTags('Reports') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.OWNER) @Controller('reports')
export class ReportsController { constructor(private readonly reports: ReportsService) {} @Get('monthly') @ApiOkResponse({ type: MonthlyReportResponse }) monthly(@Query('period') period?: string): Promise<MonthlyReport> { const month = period ? parseBusinessMonth(period) : null; if (!month) throw new BadRequestException('月份格式应为 YYYY-MM'); return this.reports.monthly(month); } }
