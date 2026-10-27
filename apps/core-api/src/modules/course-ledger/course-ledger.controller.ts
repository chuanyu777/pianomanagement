import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { PaymentChannel, Prisma, UserRole } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  CourseLedgerService,
  type CourseAccountBalance,
  type CourseAccountLedger,
} from './course-ledger.service.js';

const MONEY_STRING = /^(?:0|[1-9]\d{0,11})\.\d{2}$/;
const DateTimeSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const MoneySchema = z.string().regex(MONEY_STRING).transform((value) => new Prisma.Decimal(value));
const IdSchema = z.string().uuid();

class BalanceResponse implements CourseAccountBalance {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId!: string;

  @ApiProperty({ type: String, example: '120.00' })
  paidBalance!: string;

  @ApiProperty({ type: String, example: '80.00' })
  giftBalance!: string;

  @ApiProperty({ type: String, example: '200.00' })
  totalBalance!: string;
}

class LedgerEntryResponse {
  @ApiProperty({ type: String, format: 'uuid' }) entryId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ type: String }) kind!: string;
  @ApiProperty({ type: String, example: '100.00' }) amount!: string;
  @ApiProperty({ type: String, example: '100.00' }) paidDelta!: string;
  @ApiProperty({ type: String, example: '0.00' }) giftDelta!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String }) operator!: string;
}

class LedgerResponse {
  @ApiProperty({ type: String, format: 'uuid' }) accountId!: string;
  @ApiProperty({ type: LedgerEntryResponse, isArray: true }) entries!: LedgerEntryResponse[];
}

class RecordPaymentBody {
  @ApiProperty({ type: String, example: '500.00' })
  amount!: string;

  @ApiProperty({ enum: PaymentChannel })
  channel!: PaymentChannel;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ type: String, required: false, maxLength: 2000 })
  note?: string;
}

class RecordGiftBody {
  @ApiProperty({ type: String, example: '80.00' })
  amount!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ type: String, required: false, maxLength: 2000 })
  note?: string;
}

class ReverseLedgerEntryBody {
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ type: Number, minimum: 0, description: '确认冲正时读取到的课程账户版本' })
  accountVersion!: number;

  @ApiProperty({ type: String, required: false, maxLength: 2000 })
  note?: string;
}

const NoteSchema = z.string().trim().min(1).max(2000).optional();
const PaymentBodySchema = z.object({
  amount: MoneySchema,
  channel: z.nativeEnum(PaymentChannel),
  occurredAt: DateTimeSchema,
  note: NoteSchema,
}).strict();
const GiftBodySchema = z.object({
  amount: MoneySchema,
  occurredAt: DateTimeSchema,
  note: NoteSchema,
}).strict();
const ReverseBodySchema = z.object({
  occurredAt: DateTimeSchema,
  accountVersion: z.number().int().nonnegative(),
  note: NoteSchema,
}).strict();

function requireId(value: string): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('请求参数不合法');
  return parsed.data;
}

function requireActorId(request: AuthenticatedRequest): string {
  if (!request.actor) throw new BadRequestException('登录状态无效或已过期');
  return request.actor.id;
}

@ApiTags('Course ledger')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@Controller()
export class CourseLedgerController {
  constructor(private readonly ledger: CourseLedgerService) {}

  @Get('student-course-accounts/:accountId/balance')
  @ApiOkResponse({ type: BalanceResponse })
  getBalance(@Param('accountId') accountId: string): Promise<CourseAccountBalance> {
    return this.ledger.getBalance(requireId(accountId));
  }

  @Get('student-course-accounts/:accountId/ledger')
  @ApiOkResponse({ type: LedgerResponse })
  getLedger(@Param('accountId') accountId: string): Promise<CourseAccountLedger> {
    return this.ledger.listEntries(requireId(accountId));
  }

  @Post('student-course-accounts/:accountId/payments')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: RecordPaymentBody })
  @ApiCreatedResponse({ type: BalanceResponse })
  recordPayment(
    @Param('accountId') accountId: string,
    @Headers('idempotency-key') commandId: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<CourseAccountBalance> {
    const parsed = PaymentBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.ledger.recordPayment({
      accountId: requireId(accountId),
      ...parsed.data,
      createdById: requireActorId(request),
      commandId: requireId(commandId ?? ''),
    });
  }

  @Post('student-course-accounts/:accountId/gifts')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: RecordGiftBody })
  @ApiCreatedResponse({ type: BalanceResponse })
  recordGift(
    @Param('accountId') accountId: string,
    @Headers('idempotency-key') commandId: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<CourseAccountBalance> {
    const parsed = GiftBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.ledger.recordGift({
      accountId: requireId(accountId),
      ...parsed.data,
      createdById: requireActorId(request),
      commandId: requireId(commandId ?? ''),
    });
  }

  @Post('ledger-entries/:entryId/reversals')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: ReverseLedgerEntryBody })
  @ApiCreatedResponse({ type: BalanceResponse })
  reverseEntry(
    @Param('entryId') entryId: string,
    @Headers('idempotency-key') commandId: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<CourseAccountBalance> {
    const parsed = ReverseBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.ledger.reverseEntry({
      entryId: requireId(entryId),
      ...parsed.data,
      createdById: requireActorId(request),
      commandId: requireId(commandId ?? ''),
    });
  }
}
