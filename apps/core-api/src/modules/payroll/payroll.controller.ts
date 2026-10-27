import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PaymentChannel, Prisma, UserRole } from '../../generated/prisma/client.js';
import { parseBusinessMonth } from '../../common/time/business-calendar.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PayrollService, type CancelPayrollPaymentInput, type PayrollSummary } from './payroll.service.js';

const MONEY = /^(?:0|[1-9]\d{0,11})\.\d{2}$/;
const RATE = /^(?:0|[1-9]\d{0,2})\.\d{4}$/;
const DateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const id = z.string().uuid();

class GeneratePayrollBody { @ApiProperty({ type: String, format: 'uuid' }) teacherId!: string; @ApiProperty({ type: String, example: '2026-10' }) period!: string; }
class UpdatePayrollBody { @ApiProperty({ type: String, example: '3000.00' }) baseSalary!: string; @ApiProperty({ type: String, example: '10.0000' }) commissionRate!: string; @ApiProperty({ type: String, example: '0.00' }) bonusAmount!: string; @ApiPropertyOptional({ type: String }) bonusNote?: string; @ApiProperty({ type: String, example: '0.00' }) deductionAmount!: string; @ApiPropertyOptional({ type: String }) deductionNote?: string; }
class PayPayrollBody { @ApiProperty({ type: String, format: 'date-time' }) paidAt!: string; @ApiProperty({ type: String, enum: PaymentChannel }) channel!: PaymentChannel; @ApiPropertyOptional({ type: String }) note?: string; }
class CancelPayrollPaymentBody { @ApiProperty({ type: Number, minimum: 0 }) expectedVersion!: number; @ApiPropertyOptional({ type: String, maxLength: 2000 }) note?: string; }
class PayrollResponse implements PayrollSummary {
  @ApiProperty({ type: String }) id!: string; @ApiProperty({ type: String }) teacherId!: string; @ApiProperty({ type: String }) teacherName!: string; @ApiProperty({ type: String, format: 'date-time' }) periodStart!: Date;
  @ApiProperty({ type: String }) courseRevenue!: string; @ApiProperty({ type: String }) baseSalary!: string; @ApiProperty({ type: String }) commissionRate!: string; @ApiProperty({ type: String }) commissionAmount!: string;
  @ApiProperty({ type: String }) bonusAmount!: string; @ApiPropertyOptional({ type: String, nullable: true }) bonusNote!: string | null; @ApiProperty({ type: String }) deductionAmount!: string; @ApiPropertyOptional({ type: String, nullable: true }) deductionNote!: string | null;
  @ApiProperty({ type: String }) grossSalary!: string; @ApiProperty({ type: String }) netSalary!: string; @ApiProperty({ type: String, enum: ['UNPAID', 'PAID'] }) status!: 'UNPAID' | 'PAID'; @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) paidAt!: Date | null;
  @ApiPropertyOptional({ type: String, nullable: true, enum: PaymentChannel }) paymentChannel!: PaymentChannel | null; @ApiPropertyOptional({ type: String, nullable: true }) paymentNote!: string | null; @ApiProperty({ type: Number }) version!: number;
}
const GenerateSchema = z.object({ teacherId: id, period: z.string() }).strict();
const UpdateSchema = z.object({ baseSalary: z.string().regex(MONEY).transform((v) => new Prisma.Decimal(v)), commissionRate: z.string().regex(RATE).transform((v) => new Prisma.Decimal(v)), bonusAmount: z.string().regex(MONEY).transform((v) => new Prisma.Decimal(v)), bonusNote: z.string().trim().min(1).max(2000).optional(), deductionAmount: z.string().regex(MONEY).transform((v) => new Prisma.Decimal(v)), deductionNote: z.string().trim().min(1).max(2000).optional() }).strict();
const PaySchema = z.object({ paidAt: DateTime, channel: z.nativeEnum(PaymentChannel), note: z.string().trim().min(1).max(2000).optional() }).strict();
const CancelPaymentSchema = z.object({ expectedVersion: z.number().int().nonnegative(), note: z.string().trim().min(1).max(2000).optional() }).strict();
function actor(request: AuthenticatedRequest): string { if (!request.actor) throw new BadRequestException('登录状态无效或已过期'); return request.actor.id; }

@ApiTags('Payroll') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.OWNER) @Controller('payrolls')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}
  @Post() @ApiBody({ type: GeneratePayrollBody }) @ApiCreatedResponse({ type: PayrollResponse })
  generate(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<PayrollSummary> {
    const parsed = GenerateSchema.safeParse(body); if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const periodStart = parseBusinessMonth(parsed.data.period); if (!periodStart) throw new BadRequestException('月份格式应为 YYYY-MM');
    return this.payroll.generate({ teacherId: parsed.data.teacherId, periodStart, actorId: actor(request) });
  }
  @Get() @ApiOkResponse({ type: PayrollResponse, isArray: true })
  list(@Query('period') period?: string): Promise<PayrollSummary[]> { const periodStart = period ? parseBusinessMonth(period) : undefined; if (period && !periodStart) throw new BadRequestException('月份格式应为 YYYY-MM'); return this.payroll.list(periodStart ?? undefined); }
  @Patch(':id') @ApiBody({ type: UpdatePayrollBody }) @ApiOkResponse({ type: PayrollResponse })
  update(@Param('id') payrollId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<PayrollSummary> { const parsed = UpdateSchema.safeParse(body); if (!id.safeParse(payrollId).success || !parsed.success) throw new BadRequestException('请求参数不合法'); return this.payroll.update(payrollId, { ...parsed.data, actorId: actor(request) }); }
  @Post(':id/pay') @ApiBody({ type: PayPayrollBody }) @ApiOkResponse({ type: PayrollResponse })
  pay(@Param('id') payrollId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<PayrollSummary> { const parsed = PaySchema.safeParse(body); if (!id.safeParse(payrollId).success || !parsed.success) throw new BadRequestException('请求参数不合法'); return this.payroll.pay(payrollId, { ...parsed.data, actorId: actor(request) }); }
  @Delete(':id/payment') @ApiBody({ type: CancelPayrollPaymentBody }) @ApiOkResponse({ type: PayrollResponse })
  cancelPayment(@Param('id') payrollId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<PayrollSummary> {
    const parsed = CancelPaymentSchema.safeParse(body);
    if (!id.safeParse(payrollId).success || !parsed.success) throw new BadRequestException('请求参数不合法');
    const input: CancelPayrollPaymentInput = { ...parsed.data, actorId: actor(request) };
    return this.payroll.cancelPayment(payrollId, input);
  }
}
