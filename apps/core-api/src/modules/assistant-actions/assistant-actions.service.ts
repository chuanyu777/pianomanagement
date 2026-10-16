import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  PreviewRiskLevel,
  PreviewStatus,
  type ActionPreview,
  type BusinessAuditEvent,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const TECHNICAL_SPIKE_ACTION_TYPE = 'technical-spike.preview';
const TECHNICAL_SPIKE_SCHEMA_VERSION = 'stage0.v1';
const TECHNICAL_SPIKE_TTL_MS = 5 * 60 * 1000;
const TECHNICAL_SPIKE_EVENT_TYPE = 'assistant.preview.created';

const TECHNICAL_SPIKE_COMMAND = {
  kind: 'technical-spike',
  mode: 'preview-only',
  businessWrite: false,
} satisfies Prisma.InputJsonObject;

const TECHNICAL_SPIKE_DISPLAY = {
  title: '阶段 0 技术预览',
  summary: '仅验证 Preview 持久化、审计和幂等，不会写入任何业务数据。',
  technicalSpike: true,
  businessWrite: false,
} satisfies Prisma.InputJsonObject;

const TECHNICAL_SPIKE_RESOURCES = {
  kind: 'technical-spike',
  resources: [],
} satisfies Prisma.InputJsonObject;

export type CreateTechnicalPreviewInput = {
  actorUserId: string;
  runId: string;
  requestId: string;
  idempotencyKey: string;
  now?: Date;
};

export type TechnicalPreviewResponse = {
  preview: {
    id: string;
    actorUserId: string;
    actionType: string;
    schemaVersion: string;
    riskLevel: PreviewRiskLevel;
    normalizedCommandJson: Prisma.JsonValue;
    displayJson: Prisma.JsonValue;
    resourceVersionsJson: Prisma.JsonValue;
    idempotencyKey: string;
    status: PreviewStatus;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  };
  auditEventId: string;
  technicalSpike: true;
  businessWrite: false;
};

type CreatedPreview = {
  preview: ActionPreview;
  auditEvent: BusinessAuditEvent;
};

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  ) ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002');
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new BadRequestException(`${field} 不能为空`);
  return normalized;
}

@Injectable()
export class AssistantActionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createTechnicalSpikePreview(
    input: CreateTechnicalPreviewInput,
  ): Promise<TechnicalPreviewResponse> {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({
          data: {
            actorUserId,
            actionType: TECHNICAL_SPIKE_ACTION_TYPE,
            schemaVersion: TECHNICAL_SPIKE_SCHEMA_VERSION,
            riskLevel: PreviewRiskLevel.L1,
            normalizedCommandJson: TECHNICAL_SPIKE_COMMAND,
            displayJson: TECHNICAL_SPIKE_DISPLAY,
            resourceVersionsJson: TECHNICAL_SPIKE_RESOURCES,
            idempotencyKey,
            status: PreviewStatus.PENDING,
            expiresAt: new Date(
              (input.now ?? new Date()).getTime() + TECHNICAL_SPIKE_TTL_MS,
            ),
          },
        });

        const auditEvent = await tx.businessAuditEvent.create({
          data: {
            actorUserId,
            runId,
            previewId: preview.id,
            eventType: TECHNICAL_SPIKE_EVENT_TYPE,
            requestId,
            detailJson: {
              actionType: TECHNICAL_SPIKE_ACTION_TYPE,
              technicalSpike: true,
              businessWrite: false,
            },
          },
        });

        return { preview, auditEvent } satisfies CreatedPreview;
      });

      return this.toResponse(created);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      // 只在数据库唯一约束冲突后读取；这里没有“先查再插”的竞态窗口。
      const original = await this.findByIdempotencyKey(idempotencyKey);
      if (!original) throw error;
      if (original.preview.actorUserId !== actorUserId) {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      return this.toResponse(original);
    }
  }

  private async findByIdempotencyKey(idempotencyKey: string): Promise<CreatedPreview | null> {
    return this.prisma.$transaction(async (tx) => {
      const preview = await tx.actionPreview.findUnique({
        where: { idempotencyKey },
      });
      if (!preview) return null;

      const auditEvent = await tx.businessAuditEvent.findFirst({
        where: { previewId: preview.id },
        orderBy: { createdAt: 'asc' },
      });
      if (!auditEvent) return null;
      return { preview, auditEvent } satisfies CreatedPreview;
    });
  }

  private toResponse(created: CreatedPreview): TechnicalPreviewResponse {
    const { preview, auditEvent } = created;
    return {
      preview: {
        id: preview.id,
        actorUserId: preview.actorUserId,
        actionType: preview.actionType,
        schemaVersion: preview.schemaVersion,
        riskLevel: preview.riskLevel,
        normalizedCommandJson: preview.normalizedCommandJson,
        displayJson: preview.displayJson,
        resourceVersionsJson: preview.resourceVersionsJson,
        idempotencyKey: preview.idempotencyKey,
        status: preview.status,
        expiresAt: preview.expiresAt.toISOString(),
        createdAt: preview.createdAt.toISOString(),
        updatedAt: preview.updatedAt.toISOString(),
      },
      auditEventId: auditEvent.id,
      technicalSpike: true,
      businessWrite: false,
    };
  }
}
