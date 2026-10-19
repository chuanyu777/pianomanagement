import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PaymentChannel, UserRole } from '../../generated/prisma/client.js';
import {
  CapabilityGuard,
  type CapabilityRequest,
} from '../../common/capability/capability.guard.js';
import { RequiresCapability } from '../../common/capability/requires-capability.js';
import { InternalRequestGuard } from '../../common/internal-auth/internal-request.guard.js';
import {
  AssistantActionsService,
  type TechnicalPreviewResponse,
} from './assistant-actions.service.js';

export class CreateTechnicalPreviewBody {
  @ApiProperty({ type: String, minLength: 1 })
  idempotencyKey!: string;

  @ApiProperty({ type: String, minLength: 1 })
  requestId!: string;
}

const CreateTechnicalPreviewBodySchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    requestId: z.string().trim().min(1).max(200),
  })
  .strict();

const SingleLessonPreviewSchema = z.object({
  accountId: z.string().uuid(),
  teacherId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  note: z.string().trim().min(1).max(2000).optional(),
  idempotencyKey: z.string().uuid(),
  requestId: z.string().uuid(),
}).strict();
const BatchLessonPreviewSchema = z.object({
  accountId: z.string().uuid(),
  teacherId: z.string().uuid(),
  firstStartsAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  weeks: z.number().int().min(1).max(52),
  note: z.string().trim().min(1).max(2000).optional(),
  idempotencyKey: z.string().uuid(),
  requestId: z.string().uuid(),
}).strict();

const MoneyPreviewBaseSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/),
  occurredAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  note: z.string().trim().max(2000).optional(),
  idempotencyKey: z.string().uuid(),
  requestId: z.string().uuid(),
}).strict();
const PaymentPreviewSchema = MoneyPreviewBaseSchema.extend({ channel: z.nativeEnum(PaymentChannel) });
const FinalRefundPreviewSchema = z.object({
  studentId: z.string().uuid(),
  feeAmount: z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/),
  channel: z.nativeEnum(PaymentChannel),
  occurredAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  note: z.string().trim().min(1).max(2000).optional(),
  idempotencyKey: z.string().uuid(),
  requestId: z.string().uuid(),
}).strict();

class TechnicalPreviewCreatedResponse {
  @ApiProperty({ type: Object, description: 'Core 保存的 Preview；具体结构由 actionType 与 schemaVersion 决定' })
  preview!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'uuid' })
  auditEventId!: string;

  @ApiProperty({ type: Boolean, enum: [true], example: true })
  technicalSpike!: true;

  @ApiProperty({ type: Boolean, enum: [false], example: false })
  businessWrite!: false;
}

@ApiTags('AssistantActions')
@ApiHeader({ name: 'authorization', required: true, description: 'Bearer Capability' })
@ApiHeader({ name: 'x-internal-timestamp', required: true })
@ApiHeader({ name: 'x-internal-nonce', required: true })
@ApiHeader({ name: 'x-internal-signature', required: true })
@Controller('internal/assistant-actions')
@UseGuards(InternalRequestGuard, CapabilityGuard)
export class AssistantActionsController {
  constructor(private readonly service: AssistantActionsService) {}

  @Post('preview')
  @ApiBody({ type: CreateTechnicalPreviewBody })
  @ApiCreatedResponse({ type: TechnicalPreviewCreatedResponse })
  @RequiresCapability('PREVIEW_L1')
  createPreview(
    @Body() body: unknown,
    @Req() request: CapabilityRequest,
  ): Promise<TechnicalPreviewResponse> {
    const parsed = CreateTechnicalPreviewBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');

    return this.service.createTechnicalSpikePreview({
      actorUserId: capability.sub,
      runId: capability.runId,
      requestId: parsed.data.requestId,
      idempotencyKey: parsed.data.idempotencyKey,
    });
  }

  @Post('lessons/single/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['accountId', 'teacherId', 'startsAt', 'idempotencyKey', 'requestId'], properties: {
    accountId: { type: 'string', format: 'uuid' }, teacherId: { type: 'string', format: 'uuid' },
    startsAt: { type: 'string', format: 'date-time' }, note: { type: 'string', maxLength: 2000 },
    idempotencyKey: { type: 'string', format: 'uuid' }, requestId: { type: 'string', format: 'uuid' },
  } } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'command', 'display', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L1')
  createSingleLessonPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = SingleLessonPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createSingleLessonPreview({
      ...parsed.data,
      actorUserId: capability.sub,
      runId: capability.runId,
    });
  }

  @Post('lessons/batch/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['accountId', 'teacherId', 'firstStartsAt', 'weeks', 'idempotencyKey', 'requestId'], properties: {
    accountId: { type: 'string', format: 'uuid' }, teacherId: { type: 'string', format: 'uuid' },
    firstStartsAt: { type: 'string', format: 'date-time' }, weeks: { type: 'integer', minimum: 1, maximum: 52 },
    note: { type: 'string', maxLength: 2000 }, idempotencyKey: { type: 'string', format: 'uuid' },
    requestId: { type: 'string', format: 'uuid' },
  } } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L1')
  createBatchLessonPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = BatchLessonPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createBatchLessonPreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }

  @Post('course-accounts/payment/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['accountId', 'amount', 'channel', 'occurredAt', 'idempotencyKey', 'requestId'] } })
  @RequiresCapability('PREVIEW_L2')
  createPaymentPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = PaymentPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createPaymentPreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }

  @Post('course-accounts/gift/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['accountId', 'amount', 'occurredAt', 'idempotencyKey', 'requestId'] } })
  @RequiresCapability('PREVIEW_L2')
  createGiftPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = MoneyPreviewBaseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createGiftPreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }

  @Post('students/final-refund/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['studentId', 'feeAmount', 'channel', 'occurredAt', 'idempotencyKey', 'requestId'], properties: {
    studentId: { type: 'string', format: 'uuid' }, feeAmount: { type: 'string', pattern: '^\\d+\\.\\d{2}$' },
    channel: { type: 'string', enum: Object.values(PaymentChannel) }, occurredAt: { type: 'string', format: 'date-time' },
    note: { type: 'string', maxLength: 2000 }, idempotencyKey: { type: 'string', format: 'uuid' }, requestId: { type: 'string', format: 'uuid' },
  } } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L2')
  previewFinalRefund(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = FinalRefundPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.previewFinalRefund({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }
}

@ApiTags('AssistantActions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER, UserRole.TEACHER)
@Controller('assistant/previews')
export class AssistantPreviewConfirmController {
  constructor(private readonly service: AssistantActionsService) {}

  @Post(':previewId/confirm')
  @ApiBearerAuth()
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: { type: 'object', required: ['previewId', 'status', 'receipt'] } })
  confirm(
    @Param('previewId') previewId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const id = z.string().uuid().safeParse(previewId);
    const key = z.string().uuid().safeParse(idempotencyKey);
    if (!id.success || !key.success || !request.actor) throw new BadRequestException('请求参数不合法');
    return this.service.confirmPreview(id.data, request.actor, key.data);
  }
}
