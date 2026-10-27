import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PaymentChannel, UserRole, PreviewStatus, PreviewRiskLevel, Prisma } from '../../generated/prisma/client.js';
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
const LessonMutationPreviewBaseSchema = z.object({
  lessonId: z.string().uuid(),
  note: z.string().trim().min(1).max(2000).optional(),
  idempotencyKey: z.string().uuid(),
  requestId: z.string().uuid(),
}).strict();
const CompletionCorrectionPreviewSchema = LessonMutationPreviewBaseSchema.extend({
  correctedUnitPrice: z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/),
}).strict();
const ReschedulePreviewSchema = LessonMutationPreviewBaseSchema.extend({
  startsAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
}).strict();
const StructuredActionPreviewSchema = z.object({
  actionType: z.enum([
    'lesson.reschedule', 'lesson.cancel', 'lesson.complete', 'lesson.complete.reversal', 'lesson.complete.correction',
    'manual-transaction.create', 'payroll.generate', 'payroll.pay', 'payroll.adjust', 'payroll.cancel-payment', 'ledger-entry.reversal', 'period.close', 'period.reopen',
    'student.create', 'student.update', 'teacher.create', 'teacher.compensation.update', 'course.create', 'course.update', 'course-account.open', 'course-account.price',
  ]),
  command: z.record(z.string(), z.unknown()),
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
const InvalidatePreviewSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
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

export class AssistantPreviewStateResponse {
  @ApiProperty({type:String,format:'uuid'}) previewId!: string;
  @ApiProperty({type:String}) actionType!: string;
  @ApiProperty({type:String}) schemaVersion!: string;
  @ApiProperty({enum:PreviewRiskLevel}) riskLevel!: PreviewRiskLevel;
  @ApiProperty({enum:PreviewStatus}) status!: PreviewStatus;
  @ApiProperty({type:String,format:'date-time'}) expiresAt!: string;
  @ApiProperty({type:Object,nullable:true}) receipt!: Record<string,unknown>|null;
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

  @Get('access')
  @ApiQuery({ name: 'actionType', required: true, type: String, maxLength: 100 })
  @ApiOkResponse({ schema: { type:'object', required:['allowed'], properties:{ allowed:{ type:'boolean', enum:[true] } } } })
  @RequiresCapability('READ')
  checkActionAccess(@Query() query: unknown, @Req() request: CapabilityRequest) {
    const parsed = z.object({ actionType: z.string().min(1).max(100) }).strict().safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.checkActionAccess(request.capability!.sub, parsed.data.actionType);
  }

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

  @Get('previews/:previewId')
  @ApiOkResponse({ type: AssistantPreviewStateResponse })
  @RequiresCapability('READ')
  getPreview(@Param('previewId') previewId: string, @Req() request: CapabilityRequest) {
    const id = z.string().uuid().safeParse(previewId);
    if (!id.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.getPreviewForUser(id.data, capability.sub);
  }

  @Post('previews/:previewId/invalidate')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } } } })
  @ApiOkResponse({ schema: { type: 'object', required: ['previewId', 'status'] } })
  @RequiresCapability('READ')
  invalidatePreview(@Param('previewId') previewId: string, @Body() body: unknown, @Req() request: CapabilityRequest) {
    const id = z.string().uuid().safeParse(previewId);
    const parsed = InvalidatePreviewSchema.safeParse(body);
    if (!id.success || !parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    if (!capability.permissions.includes('PREVIEW_L1') && !capability.permissions.includes('PREVIEW_L2')) {
      throw new ForbiddenException('Capability 权限不足');
    }
    return this.service.invalidatePreview(id.data, capability.sub, parsed.data.reason);
  }

  @Post('lessons/single/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['accountId', 'teacherId', 'startsAt', 'idempotencyKey', 'requestId'], properties: {
    accountId: { type: 'string', format: 'uuid' }, teacherId: { type: 'string', format: 'uuid' },
    startsAt: { type: 'string', format: 'date-time' }, note: { type: 'string', maxLength: 2000 },
    idempotencyKey: { type: 'string', format: 'uuid' }, requestId: { type: 'string', format: 'uuid' },
  } } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'expiresAt'] } })
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
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L1')
  createBatchLessonPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = BatchLessonPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createBatchLessonPreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }

  @Post('lessons/reschedule/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['lessonId', 'startsAt', 'idempotencyKey', 'requestId'] } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L1')
  createReschedulePreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = ReschedulePreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createReschedulePreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }

  @Post('lessons/cancel/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['lessonId', 'idempotencyKey', 'requestId'] } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L1')
  createCancelPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = LessonMutationPreviewBaseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createCancelPreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }

  @Post('lessons/complete/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['lessonId', 'idempotencyKey', 'requestId'] } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L2')
  createCompletionPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = LessonMutationPreviewBaseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createCompletionPreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }

  @Post('lessons/complete/reversal/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['lessonId', 'idempotencyKey', 'requestId'] } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L2')
  createCompletionReversalPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = LessonMutationPreviewBaseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createCompletionReversalPreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }

  @Post('lessons/complete/correction/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['lessonId', 'correctedUnitPrice', 'idempotencyKey', 'requestId'] } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L2')
  createCompletionCorrectionPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = CompletionCorrectionPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createCompletionCorrectionPreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId, correctedUnitPrice: new Prisma.Decimal(parsed.data.correctedUnitPrice) });
  }

  @Post('structured-action/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['actionType', 'command', 'idempotencyKey', 'requestId'] } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
  @RequiresCapability('PREVIEW_L2')
  createStructuredActionPreview(@Body() body: unknown, @Req() request: CapabilityRequest) {
    const parsed = StructuredActionPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const capability = request.capability;
    if (!capability) throw new UnauthorizedException('缺少 Capability');
    return this.service.createStructuredActionPreview({ ...parsed.data, actorUserId: capability.sub, runId: capability.runId });
  }

  @Post('course-accounts/payment/preview')
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['accountId', 'amount', 'channel', 'occurredAt', 'idempotencyKey', 'requestId'] } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'expiresAt'] } })
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
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'expiresAt'] } })
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
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'command', 'display', 'resourceVersions', 'expiresAt'] } })
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
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER, UserRole.TEACHER)
@Controller(['assistant/previews', 'assistant/actions'])
export class AssistantPreviewConfirmController {
  constructor(private readonly service: AssistantActionsService) {}

  private browserRunId(request: AuthenticatedRequest, requestId: string): string {
    if (!request.actor) throw new UnauthorizedException('登录状态无效或已过期');
    return `browser:${request.actor.id}:${requestId}`;
  }

  @Post('lessons/single')
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'expiresAt'] } })
  createSingleLesson(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = SingleLessonPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.createSingleLessonPreview({ ...parsed.data, actorUserId: request.actor?.id ?? '', runId: this.browserRunId(request, parsed.data.requestId) });
  }

  @Post('lessons/batch')
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'expiresAt'] } })
  createBatchLessons(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = BatchLessonPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.createBatchLessonPreview({ ...parsed.data, actorUserId: request.actor?.id ?? '', runId: this.browserRunId(request, parsed.data.requestId) });
  }

  @Post('lessons/reschedule')
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'expiresAt'] } })
  createReschedule(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = ReschedulePreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.createReschedulePreview({ ...parsed.data, actorUserId: request.actor?.id ?? '', runId: this.browserRunId(request, parsed.data.requestId) });
  }

  @Post('lessons/cancel')
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'expiresAt'] } })
  createCancel(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = LessonMutationPreviewBaseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.createCancelPreview({ ...parsed.data, actorUserId: request.actor?.id ?? '', runId: this.browserRunId(request, parsed.data.requestId) });
  }

  @Post('lessons/complete')
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'expiresAt'] } })
  createCompletion(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = LessonMutationPreviewBaseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.createCompletionPreview({ ...parsed.data, actorUserId: request.actor?.id ?? '', runId: this.browserRunId(request, parsed.data.requestId) });
  }

  @Post('structured-action')
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'expiresAt'] } })
  createStructuredAction(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = StructuredActionPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.createStructuredActionPreview({ ...parsed.data, actorUserId: request.actor?.id ?? '', runId: this.browserRunId(request, parsed.data.requestId) });
  }

  @Post('course-accounts/payment')
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'expiresAt'] } })
  createPayment(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = PaymentPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.createPaymentPreview({ ...parsed.data, actorUserId: request.actor?.id ?? '', runId: this.browserRunId(request, parsed.data.requestId) });
  }

  @Post('course-accounts/gift')
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'expiresAt'] } })
  createGift(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = MoneyPreviewBaseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.createGiftPreview({ ...parsed.data, actorUserId: request.actor?.id ?? '', runId: this.browserRunId(request, parsed.data.requestId) });
  }

  @Post('students/final-refund')
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ schema: { type: 'object', required: ['previewId', 'actionType', 'riskLevel', 'expiresAt'] } })
  createFinalRefund(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = FinalRefundPreviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.service.previewFinalRefund({ ...parsed.data, actorUserId: request.actor?.id ?? '', runId: this.browserRunId(request, parsed.data.requestId) });
  }

  @Get(':previewId')
  @ApiBearerAuth()
  @ApiOkResponse({ type: AssistantPreviewStateResponse })
  get(@Param('previewId') previewId: string, @Req() request: AuthenticatedRequest) {
    const id = z.string().uuid().safeParse(previewId);
    if (!id.success || !request.actor) throw new BadRequestException('请求参数不合法');
    return this.service.getPreview(id.data, request.actor);
  }

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
