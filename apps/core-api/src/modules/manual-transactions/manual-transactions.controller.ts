import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ManualExpenseCategory, ManualIncomeCategory, ManualTransactionKind, PaymentChannel, Prisma, UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ManualTransactionsService, type ManualTransactionSummary } from './manual-transactions.service.js';

const MONEY = /^(?:0|[1-9]\d{0,11})\.\d{2}$/;
const DateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value));

class CreateManualTransactionBody {
  @ApiProperty({ type: String, enum: ManualTransactionKind })
  kind!: ManualTransactionKind;
  @ApiPropertyOptional({ type: String, enum: ManualIncomeCategory })
  incomeCategory?: ManualIncomeCategory;
  @ApiPropertyOptional({ type: String, enum: ManualExpenseCategory })
  expenseCategory?: ManualExpenseCategory;
  @ApiProperty({ type: String, example: '100.00' })
  amount!: string;
  @ApiProperty({ type: String, enum: PaymentChannel })
  channel!: PaymentChannel;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;
  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  note?: string;
}

class ManualTransactionResponse implements ManualTransactionSummary {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, enum: ManualTransactionKind }) kind!: ManualTransactionKind;
  @ApiPropertyOptional({ type: String, enum: ManualIncomeCategory, nullable: true }) incomeCategory!: ManualIncomeCategory | null;
  @ApiPropertyOptional({ type: String, enum: ManualExpenseCategory, nullable: true }) expenseCategory!: ManualExpenseCategory | null;
  @ApiProperty({ type: String, example: '100.00' }) amount!: string;
  @ApiProperty({ type: String, enum: PaymentChannel }) channel!: PaymentChannel;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: Date;
  @ApiPropertyOptional({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

const CreateSchema = z.object({
  kind: z.nativeEnum(ManualTransactionKind),
  incomeCategory: z.nativeEnum(ManualIncomeCategory).optional(),
  expenseCategory: z.nativeEnum(ManualExpenseCategory).optional(),
  amount: z.string().regex(MONEY).transform((value) => new Prisma.Decimal(value)),
  channel: z.nativeEnum(PaymentChannel),
  occurredAt: DateTime,
  note: z.string().trim().min(1).max(2000).optional(),
}).strict();

const ListSchema = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).strict();

function requireActor(request: AuthenticatedRequest): string {
  if (!request.actor) throw new BadRequestException('登录状态无效或已过期');
  return request.actor.id;
}

@ApiTags('Manual transactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@Controller('manual-transactions')
export class ManualTransactionsController {
  constructor(private readonly transactions: ManualTransactionsService) {}

  @Post()
  @ApiBody({ type: CreateManualTransactionBody })
  @ApiCreatedResponse({ type: ManualTransactionResponse })
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<ManualTransactionSummary> {
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.transactions.create({ ...parsed.data, createdById: requireActor(request) });
  }

  @Get()
  @ApiOkResponse({ type: ManualTransactionResponse, isArray: true })
  list(@Query() query: unknown): Promise<ManualTransactionSummary[]> {
    const parsed = ListSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const from = parsed.data.from ? new Date(parsed.data.from) : undefined;
    const to = parsed.data.to ? new Date(parsed.data.to) : undefined;
    if (from && to && from >= to) throw new BadRequestException('查询结束时间必须晚于开始时间');
    return this.transactions.list(from, to);
  }
}
