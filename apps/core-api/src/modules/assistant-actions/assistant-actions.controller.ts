import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiHeader, ApiProperty, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
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
}
