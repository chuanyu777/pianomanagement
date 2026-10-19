import { BadRequestException, Body, Controller, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiTags,
} from '@nestjs/swagger';
import { PaymentChannel, UserRole } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CreateRefundBody, RefundResponse } from './refunds.dto.js';
import { RefundsService, type RefundSummary } from './refunds.service.js';

const IdSchema = z.string().uuid();
const MoneySchema = z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/);
const DateTimeSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const CreateRefundSchema = z.object({
  feeAmount: MoneySchema,
  channel: z.nativeEnum(PaymentChannel),
  occurredAt: DateTimeSchema,
  note: z.string().trim().min(1).max(2000).optional(),
}).strict();

function requiredId(value: string): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('请求参数不合法');
  return parsed.data;
}

@ApiTags('Refunds')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@Controller('students')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post(':studentId/refunds')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: CreateRefundBody })
  @ApiCreatedResponse({ type: RefundResponse })
  create(
    @Param('studentId') studentId: string,
    @Headers('idempotency-key') commandId: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<RefundSummary> {
    const parsed = CreateRefundSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const actor = request.actor;
    if (!actor) throw new BadRequestException('登录状态无效或已过期');
    return this.refunds.refund({
      studentId: requiredId(studentId),
      feeAmount: parsed.data.feeAmount,
      channel: parsed.data.channel,
      occurredAt: parsed.data.occurredAt,
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      commandId: requiredId(commandId ?? ''),
    }, actor);
  }
}
