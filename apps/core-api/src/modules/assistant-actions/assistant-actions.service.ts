import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PreviewRiskLevel,
  PreviewStatus,
  type PaymentChannel,
  type ActionPreview,
  type BusinessAuditEvent,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthenticatedActor } from '../auth/auth.types.js';
import { LessonsService, type CreateBatchLessonsInput, type CreateSingleLessonInput } from '../lessons/lessons.service.js';
import { CourseLedgerService, type CourseAccountBalance } from '../course-ledger/course-ledger.service.js';
import { RefundsService, type CreateRefundInput } from '../refunds/refunds.service.js';

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

type FinalRefundPreviewInput = Omit<CreateRefundInput, 'commandId'> & {
  actorUserId: string;
  runId: string;
  requestId: string;
  idempotencyKey: string;
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

function toDisplayBalance(balance: CourseAccountBalance): CourseAccountBalance {
  return {
    accountId: balance.accountId,
    paidBalance: balance.paidBalance,
    giftBalance: balance.giftBalance,
    totalBalance: balance.totalBalance,
  };
}

@Injectable()
export class AssistantActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lessons: LessonsService,
    private readonly ledger: CourseLedgerService,
    private readonly refunds?: RefundsService,
  ) {}

  async previewFinalRefund(input: FinalRefundPreviewInput) {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const actor = await this.loadActor(actorUserId);
    if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可预览退学退款');
    const feeAmount = this.parseRefundFee(input.feeAmount);
    if (!Number.isFinite(input.occurredAt.getTime())) throw new BadRequestException('退费时间无效');
    const actionType = 'student.final-refund';
    const normalizedCommand = {
      studentId: input.studentId,
      feeAmount: feeAmount.toFixed(2),
      channel: input.channel,
      occurredAt: input.occurredAt.toISOString(),
      note: input.note?.trim() || null,
    } satisfies Prisma.InputJsonObject;

    const calculated = await this.calculateFinalRefund(input.studentId, feeAmount);
    const display = {
      title: '最终退学退款',
      summary: `共 ${calculated.courses.length} 门课程，实际退款 ¥${calculated.actualRefundAmount}`,
      studentId: input.studentId,
      studentName: calculated.studentName,
      studentStatusBefore: calculated.studentStatusBefore,
      studentStatusAfter: '退学',
      courses: calculated.courses,
      totalPaidRefund: calculated.totalPaidRefund,
      feeAmount: calculated.feeAmount,
      feePercentage: calculated.feePercentage,
      actualRefundAmount: calculated.actualRefundAmount,
    } satisfies Prisma.InputJsonObject;
    const resourceVersions = {
      studentId: input.studentId,
      studentUpdatedAt: calculated.studentUpdatedAt.toISOString(),
      accountVersions: calculated.accountVersions,
    } satisfies Prisma.InputJsonObject;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({ data: {
          actorUserId,
          actionType,
          schemaVersion: `${actionType}.v1`,
          riskLevel: PreviewRiskLevel.L2,
          normalizedCommandJson: normalizedCommand,
          displayJson: display,
          resourceVersionsJson: resourceVersions,
          idempotencyKey,
          status: PreviewStatus.PENDING,
          expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId, previewId: preview.id,
          eventType: 'assistant.preview.created', requestId,
          resourceType: 'student', resourceId: input.studentId,
          detailJson: { actionType, schemaVersion: `${actionType}.v1` },
        } });
        return { preview, audit };
      });
      return {
        previewId: created.preview.id,
        actionType: created.preview.actionType,
        command: created.preview.normalizedCommandJson,
        display: created.preview.displayJson,
        resourceVersions: created.preview.resourceVersionsJson,
        expiresAt: created.preview.expiresAt.toISOString(),
        auditEventId: created.audit.id,
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const prior = await this.prisma.actionPreview.findUnique({ where: { idempotencyKey } });
      if (!prior || prior.actorUserId !== actorUserId || prior.actionType !== actionType) {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      if (JSON.stringify(prior.normalizedCommandJson) !== JSON.stringify(normalizedCommand)) {
        throw new ConflictException('幂等键已用于不同的最终退学退款请求');
      }
      const audit = await this.prisma.businessAuditEvent.findFirst({
        where: { previewId: prior.id, eventType: 'assistant.preview.created' },
        orderBy: { createdAt: 'asc' }, select: { id: true },
      });
      if (!audit) throw new ConflictException('幂等预览审计记录不存在');
      return {
        previewId: prior.id, actionType: prior.actionType,
        command: prior.normalizedCommandJson, display: prior.displayJson,
        resourceVersions: prior.resourceVersionsJson,
        expiresAt: prior.expiresAt.toISOString(), auditEventId: audit.id,
      };
    }
  }

  private parseRefundFee(feeAmount: Prisma.Decimal | string): Prisma.Decimal {
    try {
      const parsed = new Prisma.Decimal(feeAmount);
      if (!parsed.isFinite() || parsed.isNegative() || parsed.decimalPlaces() > 2 || parsed.gt('999999999999.99')) {
        throw new BadRequestException('手续费金额无效');
      }
      return parsed;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('手续费金额无效');
    }
  }

  private async calculateFinalRefund(studentId: string, feeAmount: Prisma.Decimal) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, withdrawnAt: true, updatedAt: true },
    });
    if (!student) throw new NotFoundException('学生不存在');
    const existingRefund = await this.prisma.refundRecord.findUnique({ where: { studentId }, select: { id: true } });
    if (existingRefund) throw new ConflictException('该学生已登记退费');
    const accounts = await this.prisma.studentCourseAccount.findMany({
      where: { studentId }, orderBy: { id: 'asc' },
      select: { id: true, version: true, openingPaidBalance: true, openingGiftBalance: true, course: { select: { name: true } } },
    });
    const accountIds = accounts.map(({ id }) => id);
    const entries = accountIds.length === 0 ? [] : await this.prisma.ledgerEntry.findMany({
      where: { accountId: { in: accountIds } }, select: { accountId: true, paidDelta: true, giftDelta: true },
    });
    const balances = new Map(accounts.map((account) => [account.id, {
      paid: new Prisma.Decimal(account.openingPaidBalance), gift: new Prisma.Decimal(account.openingGiftBalance),
    }]));
    for (const entry of entries) {
      const balance = balances.get(entry.accountId);
      if (balance) {
        balance.paid = balance.paid.add(entry.paidDelta);
        balance.gift = balance.gift.add(entry.giftDelta);
      }
    }
    const zero = new Prisma.Decimal(0);
    const courses = accounts.map((account) => {
      const balance = balances.get(account.id)!;
      if (balance.paid.isNegative()) throw new BadRequestException(`课程账户 ${account.id} 的实收余额为负数，不能办理退费`);
      return {
        accountId: account.id,
        courseName: account.course.name,
        paidBalanceBefore: balance.paid.toFixed(2),
        giftBalanceBefore: balance.gift.toFixed(2),
        paidRefundAmount: (balance.paid.gt(0) ? balance.paid : zero).toFixed(2),
        giftClearingAmount: (balance.gift.gt(0) ? balance.gift : zero).toFixed(2),
      };
    });
    const totalPaidRefund = courses.reduce((sum, course) => sum.add(course.paidRefundAmount), zero);
    if (feeAmount.gt(totalPaidRefund)) throw new BadRequestException('手续费不能大于实收退费总额');
    const feePercentage = totalPaidRefund.isZero() ? zero : feeAmount.div(totalPaidRefund).mul(100).toDecimalPlaces(2);
    return {
      studentName: student.name,
      studentStatusBefore: student.withdrawnAt ? '退学' : '在读',
      studentUpdatedAt: student.updatedAt,
      accountVersions: accounts.map(({ id, version }) => ({ accountId: id, version })),
      courses,
      totalPaidRefund: totalPaidRefund.toFixed(2),
      feeAmount: feeAmount.toFixed(2),
      feePercentage: feePercentage.toFixed(2),
      actualRefundAmount: totalPaidRefund.sub(feeAmount).toFixed(2),
    };
  }

  async createPaymentPreview(input: {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
    accountId: string; amount: string; channel: PaymentChannel; occurredAt: Date; note?: string | undefined;
  }) {
    return this.createMoneyPreview({ ...input, action: 'PAYMENT' });
  }

  async createGiftPreview(input: {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
    accountId: string; amount: string; occurredAt: Date; note?: string | undefined;
  }) {
    return this.createMoneyPreview({ ...input, action: 'GIFT' });
  }

  private async createMoneyPreview(input: {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
    accountId: string; amount: string; occurredAt: Date;
    action: 'PAYMENT' | 'GIFT'; channel?: PaymentChannel | undefined; note?: string | undefined;
  }) {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const amount = new Prisma.Decimal(input.amount);
    if (!amount.isFinite() || !amount.gt(0) || amount.toFixed(2) !== input.amount) {
      throw new BadRequestException('金额必须是大于零的两位小数字符串');
    }
    const actor = await this.loadActor(actorUserId);
    if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可预览资金操作');
    const actionType = input.action === 'PAYMENT' ? 'course-account.payment' : 'course-account.gift';
    const commandId = input.idempotencyKey;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const account = await tx.studentCourseAccount.findUnique({ where: { id: input.accountId }, select: { id: true } });
        if (!account) throw new NotFoundException('学生课程账户不存在');
        const snapshot = await this.ledger.getPreviewSnapshotInTransaction(tx, input.accountId);
        const projected = this.ledger.projectBalance(snapshot, input.action, amount);
        const command = {
          accountId: input.accountId,
          amount: amount.toFixed(2),
          ...(input.action === 'PAYMENT' ? { channel: input.channel } : {}),
          occurredAt: input.occurredAt.toISOString(),
          note: input.note?.trim() || null,
        } satisfies Prisma.InputJsonObject;
        const preview = await tx.actionPreview.create({ data: {
          actorUserId,
          actionType,
          schemaVersion: `${actionType}.v1`,
          riskLevel: PreviewRiskLevel.L2,
          normalizedCommandJson: command,
          displayJson: {
            title: input.action === 'PAYMENT' ? '课程交费' : '课程赠送',
            summary: input.action === 'PAYMENT' ? `交费 ¥${amount.toFixed(2)}` : `赠送 ¥${amount.toFixed(2)}`,
            beforeBalance: toDisplayBalance(projected.before),
            afterBalance: toDisplayBalance(projected.after),
          } as unknown as Prisma.InputJsonObject,
          resourceVersionsJson: { accountId: input.accountId, accountVersion: snapshot.version },
          idempotencyKey: commandId,
          status: PreviewStatus.PENDING,
          expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId, previewId: preview.id,
          eventType: 'assistant.preview.created', requestId,
          resourceType: 'student-course-account', resourceId: input.accountId,
          detailJson: { actionType, schemaVersion: `${actionType}.v1`, accountVersion: snapshot.version },
        } });
        return { preview, auditEvent: audit } satisfies CreatedPreview;
      });
      return this.toMoneyPreviewResponse(result);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // 只在唯一约束冲突后读取并核验，避免“先查再插”的竞态窗口。
      const original = await this.findByIdempotencyKey(commandId);
      if (!original || original.preview.actorUserId !== actorUserId || original.preview.actionType !== actionType) {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      const command = original.preview.normalizedCommandJson as {
        accountId?: string; amount?: string; channel?: PaymentChannel; occurredAt?: string; note?: string | null;
      };
      if (
        command.accountId !== input.accountId ||
        command.amount !== amount.toFixed(2) ||
        command.occurredAt !== input.occurredAt.toISOString() ||
        (command.note ?? null) !== (input.note?.trim() || null) ||
        (input.action === 'PAYMENT' && command.channel !== input.channel)
      ) {
        throw new ConflictException('幂等键已用于不同的资金预览请求');
      }
      return this.toMoneyPreviewResponse(original);
    }
  }

  private toMoneyPreviewResponse(created: CreatedPreview) {
    return {
      previewId: created.preview.id,
      actionType: created.preview.actionType,
      command: created.preview.normalizedCommandJson,
      display: created.preview.displayJson,
      expiresAt: created.preview.expiresAt.toISOString(),
      auditEventId: created.auditEvent.id,
    };
  }

  async confirmMoneyPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview || !['course-account.payment', 'course-account.gift'].includes(preview.actionType)) {
        throw new NotFoundException('资金预览不存在');
      }
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的资金预览');
      if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可确认资金操作');
      if (preview.status === PreviewStatus.EXECUTED) {
        const receiptEvent = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const receipt = receiptEvent?.detailJson as (Record<string, unknown> & { idempotencyKey?: string }) | null;
        if (receipt?.idempotencyKey !== idempotencyKey) throw new ConflictException('资金预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: receipt ? { ...receipt, auditEventId: receiptEvent?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('资金预览已不能确认');
      const now = new Date();
      if (preview.expiresAt <= now) throw new ConflictException('资金预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as unknown as {
        accountId: string; amount: string; channel?: PaymentChannel; occurredAt: string; note: string | null;
      };
      const versions = preview.resourceVersionsJson as unknown as { accountId: string; accountVersion: number };
      if (command.accountId !== versions.accountId) throw new ConflictException('资金预览账户快照无效');
      const current = await this.ledger.getPreviewSnapshotInTransaction(tx, command.accountId);
      if (current.version !== versions.accountVersion) throw new ConflictException('课程账户余额已变化，请重新预览');
      const amount = new Prisma.Decimal(command.amount);
      const happenedAt = new Date(command.occurredAt);
      const ledgerInput = {
        accountId: command.accountId,
        amount,
        occurredAt: happenedAt,
        ...(command.note ? { note: command.note } : {}),
        createdById: actor.id,
        commandId: idempotencyKey,
      };
      const after = preview.actionType === 'course-account.payment'
        ? await this.ledger.recordPaymentInTransaction(tx, { ...ledgerInput, channel: command.channel! })
        : await this.ledger.recordGiftInTransaction(tx, ledgerInput);
      const entry = await tx.ledgerEntry.findUnique({ where: { commandId: idempotencyKey }, select: { id: true } });
      if (!entry) throw new ConflictException('资金流水未能创建');
      await tx.actionPreview.update({ where: { id: previewId }, data: { status: PreviewStatus.EXECUTED, executedAt: now } });
      const receipt = {
        actionType: preview.actionType,
        ledgerEntryId: entry.id,
        idempotencyKey,
        accountId: command.accountId,
        amount: command.amount,
        occurredAt: happenedAt.toISOString(),
        balanceAfter: after,
        executedAt: now.toISOString(),
      };
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed',
        requestId: idempotencyKey, resourceType: 'ledger-entry', resourceId: entry.id,
        detailJson: receipt,
      } });
      return { previewId, status: PreviewStatus.EXECUTED, receipt: {
        ...receipt, auditEventId: audit.id,
      } };
    });
  }

  async confirmPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    const preview = await this.prisma.actionPreview.findUnique({ where: { id: previewId }, select: { actionType: true } });
    if (preview?.actionType === 'course-account.payment' || preview?.actionType === 'course-account.gift') {
      return this.confirmMoneyPreview(previewId, actor, idempotencyKey);
    }
    if (preview?.actionType === 'lesson.schedule.weekly-batch') {
      return this.confirmBatchLessonPreview(previewId, actor, idempotencyKey);
    }
    if (preview?.actionType === 'student.final-refund') {
      return this.confirmFinalRefundPreview(previewId, actor, idempotencyKey);
    }
    return this.confirmSingleLessonPreview(previewId, actor, idempotencyKey);
  }

  async confirmFinalRefundPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    if (!this.refunds) throw new ConflictException('退学退款执行服务未配置');
    const refunds = this.refunds;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview || preview.actionType !== 'student.final-refund') throw new NotFoundException('最终退学退款预览不存在');
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的退款预览');
      if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可确认退学退款');
      if (preview.status === PreviewStatus.EXECUTED) {
        const event = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const receipt = event?.detailJson as { idempotencyKey?: string } | null;
        if (receipt?.idempotencyKey !== idempotencyKey) throw new ConflictException('退款预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: receipt ? { ...receipt, auditEventId: event?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('退款预览已不能确认');
      if (preview.expiresAt <= new Date()) throw new ConflictException('退款预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as unknown as {
        studentId: string; feeAmount: string; channel: PaymentChannel; occurredAt: string; note: string | null;
      };
      const versions = preview.resourceVersionsJson as unknown as {
        studentId: string; studentUpdatedAt: string; accountVersions: Array<{ accountId: string; version: number }>;
      };
      if (versions.studentId !== command.studentId) throw new ConflictException('退款预览学生快照无效');
      const lockedStudent = await tx.$queryRaw<Array<{ id: string; updatedAt: Date }>>`
        SELECT "id", "updatedAt" FROM "Student" WHERE "id" = ${command.studentId} FOR UPDATE
      `;
      if (lockedStudent.length !== 1 || lockedStudent[0]!.updatedAt.toISOString() !== versions.studentUpdatedAt) {
        throw new ConflictException('学生资料已变化，请重新预览');
      }
      const lockedAccounts = await tx.$queryRaw<Array<{ id: string; version: number }>>`
        SELECT "id", "version" FROM "StudentCourseAccount" WHERE "studentId" = ${command.studentId} ORDER BY "id" FOR UPDATE
      `;
      if (lockedAccounts.length !== versions.accountVersions.length || lockedAccounts.some((account, index) => {
        const expected = versions.accountVersions[index];
        return !expected || expected.accountId !== account.id || expected.version !== account.version;
      })) {
        throw new ConflictException('课程账户余额已变化，请重新预览');
      }
      const refund = await refunds.refund({
        studentId: command.studentId,
        feeAmount: command.feeAmount,
        channel: command.channel,
        occurredAt: new Date(command.occurredAt),
        ...(command.note ? { note: command.note } : {}),
        commandId: idempotencyKey,
      }, actor);
      const now = new Date();
      await tx.actionPreview.update({ where: { id: previewId }, data: { status: PreviewStatus.EXECUTED, executedAt: now } });
      const receipt = {
        actionType: preview.actionType,
        refundId: refund.id,
        studentId: refund.studentId,
        totalPaidRefund: refund.totalPaidRefund,
        feeAmount: refund.feeAmount,
        feePercentage: refund.feePercentage,
        actualRefundAmount: refund.actualRefundAmount,
        courses: refund.details,
        studentStatus: '退学',
        idempotencyKey,
        executedAt: now.toISOString(),
      } satisfies Prisma.InputJsonObject;
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed',
        requestId: idempotencyKey, resourceType: 'refund', resourceId: refund.id,
        detailJson: receipt,
      } });
      return { previewId, status: PreviewStatus.EXECUTED, receipt: { ...receipt, auditEventId: audit.id } };
    });
  }

  async createBatchLessonPreview(input: CreateBatchLessonsInput & {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
  }) {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const actor = await this.loadActor(actorUserId);
    const batch = await this.lessons.previewBatch(input, actor);
    const actionType = 'lesson.schedule.weekly-batch';
    const normalizedCommand = {
      ...batch.normalizedCommand,
      firstStartsAt: batch.normalizedCommand.firstStartsAt.toISOString(),
      note: batch.normalizedCommand.note ?? null,
    };
    const resourceVersions = {
      ...batch.resourceVersions,
      teacherUpdatedAt: batch.resourceVersions.teacherUpdatedAt.toISOString(),
    };
    const display = {
      title: '每周批量排课',
      summary: `每周一节，共 ${batch.lessons.length} 节${batch.conflicts.length ? `，发现 ${batch.conflicts.length} 项时间冲突` : ''}`,
      lessons: batch.lessons.map((lesson, index) => ({
        week: index + 1,
        startsAt: lesson.startsAt.toISOString(),
        endsAt: lesson.endsAt.toISOString(),
      })),
      conflicts: batch.conflicts,
    };
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({ data: {
          actorUserId,
          actionType,
          schemaVersion: `${actionType}.v1`,
          riskLevel: PreviewRiskLevel.L1,
          normalizedCommandJson: normalizedCommand as unknown as Prisma.InputJsonObject,
          displayJson: display as unknown as Prisma.InputJsonObject,
          resourceVersionsJson: resourceVersions as unknown as Prisma.InputJsonObject,
          idempotencyKey,
          status: PreviewStatus.PENDING,
          expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId, previewId: preview.id, eventType: 'assistant.preview.created', requestId,
          resourceType: 'lesson-batch', resourceId: input.accountId,
          detailJson: { actionType, schemaVersion: `${actionType}.v1`, weeks: input.weeks, conflictCount: batch.conflicts.length },
        } });
        return { preview, audit };
      });
      return { previewId: created.preview.id, actionType: created.preview.actionType,
        command: created.preview.normalizedCommandJson, display: created.preview.displayJson,
        resourceVersions: created.preview.resourceVersionsJson,
        expiresAt: created.preview.expiresAt.toISOString(), auditEventId: created.audit.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const prior = await this.prisma.actionPreview.findUnique({ where: { idempotencyKey } });
      if (!prior || prior.actorUserId !== actorUserId || prior.actionType !== actionType) {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      const command = prior.normalizedCommandJson as { accountId?: string; teacherId?: string; firstStartsAt?: string; weeks?: number; note?: string | null };
      if (command.accountId !== normalizedCommand.accountId || command.teacherId !== normalizedCommand.teacherId ||
        command.firstStartsAt !== normalizedCommand.firstStartsAt || command.weeks !== normalizedCommand.weeks ||
        (command.note ?? null) !== normalizedCommand.note) {
        throw new ConflictException('幂等键已用于不同的批量排课请求');
      }
      const audit = await this.prisma.businessAuditEvent.findFirst({
        where: { previewId: prior.id, eventType: 'assistant.preview.created' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!audit) throw new ConflictException('幂等预览审计记录不存在');
      return { previewId: prior.id, actionType: prior.actionType, command: prior.normalizedCommandJson,
        display: prior.displayJson, resourceVersions: prior.resourceVersionsJson, expiresAt: prior.expiresAt.toISOString(), auditEventId: audit.id };
    }
  }

  async confirmBatchLessonPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview || preview.actionType !== 'lesson.schedule.weekly-batch') throw new NotFoundException('批量排课预览不存在');
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的排课预览');
      if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以批量排课');
      if (preview.status === PreviewStatus.EXECUTED) {
        const event = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const receipt = event?.detailJson as { idempotencyKey?: string; lessonIds?: string[] } | null;
        if (receipt?.idempotencyKey !== idempotencyKey) throw new ConflictException('批量排课预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: receipt ? { ...receipt, auditEventId: event?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('批量排课预览已不能确认');
      const now = new Date();
      if (preview.expiresAt <= now) throw new ConflictException('批量排课预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as unknown as CreateBatchLessonsInput & { firstStartsAt: string; note: string | null };
      const versions = preview.resourceVersionsJson as unknown as {
        accountId: string; accountVersion: number; teacherId: string; teacherUpdatedAt: string;
      };
      const lessons = await this.lessons.createBatchInTransaction(tx, {
        ...command,
        firstStartsAt: new Date(command.firstStartsAt),
        ...(command.note ? { note: command.note } : {}),
      }, actor, {
        ...versions,
        teacherUpdatedAt: new Date(versions.teacherUpdatedAt),
      });
      const updated = await tx.actionPreview.update({ where: { id: previewId }, data: { status: PreviewStatus.EXECUTED, executedAt: now } });
      const receipt = { actionType: preview.actionType, lessonIds: lessons.map(({ id }) => id), count: lessons.length,
        idempotencyKey, executedAt: now.toISOString() };
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed', requestId: idempotencyKey,
        resourceType: 'lesson-batch', resourceId: preview.id, detailJson: receipt,
      } });
      return { previewId: updated.id, status: updated.status, receipt: { ...receipt, auditEventId: audit.id } };
    });
  }

  async createSingleLessonPreview(input: CreateSingleLessonInput & {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
  }): Promise<{ previewId: string; actionType: string; command: Prisma.JsonValue; display: Prisma.JsonValue; expiresAt: string }> {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const actor = await this.loadActor(actorUserId);
    const normalized = await this.lessons.previewSingle(input, actor);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({ data: {
          actorUserId,
          actionType: 'lesson.schedule.single',
          schemaVersion: 'lesson.schedule.single.v1',
          riskLevel: PreviewRiskLevel.L1,
          normalizedCommandJson: {
            ...normalized.normalizedCommand,
            startsAt: normalized.normalizedCommand.startsAt.toISOString(),
            endsAt: normalized.normalizedCommand.endsAt.toISOString(),
          } as unknown as Prisma.InputJsonObject,
          displayJson: { title: '单节排课', summary: '确认后创建一节排课记录。' },
          resourceVersionsJson: {
            ...normalized.resourceVersions,
            conflicts: normalized.resourceVersions.conflicts.map((conflict) => ({
              ...conflict,
              startsAt: conflict.startsAt.toISOString(),
              endsAt: conflict.endsAt.toISOString(),
            })),
          } as unknown as Prisma.InputJsonObject,
          idempotencyKey,
          status: PreviewStatus.PENDING,
          expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId: input.runId, previewId: preview.id,
          eventType: 'assistant.preview.created', requestId: input.requestId,
          resourceType: 'lesson', resourceId: input.accountId,
          detailJson: { actionType: 'lesson.schedule.single', schemaVersion: 'lesson.schedule.single.v1' },
        } });
        return { preview, audit };
      });
      return { previewId: result.preview.id, actionType: result.preview.actionType,
        command: result.preview.normalizedCommandJson, display: result.preview.displayJson,
        expiresAt: result.preview.expiresAt.toISOString() };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const prior = await this.prisma.actionPreview.findUnique({ where: { idempotencyKey } });
      if (!prior || prior.actorUserId !== actorUserId || prior.actionType !== 'lesson.schedule.single') {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      const priorCommand = prior.normalizedCommandJson as { accountId?: string; teacherId?: string; startsAt?: string; note?: string | null };
      if (priorCommand.accountId !== normalized.normalizedCommand.accountId ||
        priorCommand.teacherId !== normalized.normalizedCommand.teacherId ||
        priorCommand.startsAt !== normalized.normalizedCommand.startsAt.toISOString() ||
        (priorCommand.note ?? null) !== (normalized.normalizedCommand.note ?? null)) {
        throw new ConflictException('幂等键已用于不同的排课请求');
      }
      return { previewId: prior.id, actionType: prior.actionType,
        command: prior.normalizedCommandJson, display: prior.displayJson,
        expiresAt: prior.expiresAt.toISOString() };
    }
  }

  async confirmSingleLessonPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview || preview.actionType !== 'lesson.schedule.single') throw new NotFoundException('排课预览不存在');
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的排课预览');
      if (preview.status === PreviewStatus.EXECUTED) {
        const receipt = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const detail = receipt?.detailJson as { idempotencyKey?: string; lessonId?: string; executedAt?: string } | null;
        if (detail?.idempotencyKey !== idempotencyKey) throw new ConflictException('排课预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: detail ? { ...detail, auditEventId: receipt?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('排课预览已不能确认');
      if (preview.expiresAt <= new Date()) throw new ConflictException('排课预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as unknown as CreateSingleLessonInput & { endsAt: string };
      const snapshot = preview.resourceVersionsJson as unknown as {
        accountId: string; accountVersion: number; teacherId: string;
        conflicts: Array<{ id: string; version: number; startsAt: string; endsAt: string }>;
      };
      if (actor.role === 'TEACHER' && actor.teacherId !== command.teacherId) throw new ForbiddenException('不能为其他教师确认排课');
      const startsAt = new Date(command.startsAt);
      const endsAt = new Date(command.endsAt);
      const lesson = await this.lessons.createSingleInTransaction(tx, {
        ...command, startsAt, endsAt,
      }, actor, { ...snapshot, conflicts: snapshot.conflicts.map((conflict) => ({
        ...conflict, startsAt: new Date(conflict.startsAt), endsAt: new Date(conflict.endsAt),
      })) });
      const now = new Date();
      const updated = await tx.actionPreview.update({ where: { id: previewId }, data: {
        status: PreviewStatus.EXECUTED, executedAt: now,
      } });
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed',
        requestId: idempotencyKey, resourceType: 'lesson', resourceId: lesson.id,
        detailJson: { lessonId: lesson.id, idempotencyKey, executedAt: now.toISOString() },
      } });
      return { previewId: updated.id, status: updated.status, receipt: {
        lessonId: lesson.id, auditEventId: audit.id, idempotencyKey, executedAt: now.toISOString(),
      } };
    });
  }

  private async loadActor(userId: string): Promise<AuthenticatedActor> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: {
      id: true, username: true, role: true, isActive: true, teacher: { select: { id: true, isActive: true } },
    } });
    if (!user?.isActive) throw new ForbiddenException('Capability 用户不可用');
    if (user.role === 'TEACHER' && (!user.teacher?.isActive)) throw new ForbiddenException('教师账号不可用');
    return { id: user.id, username: user.username, role: user.role, ...(user.teacher ? { teacherId: user.teacher.id } : {}) };
  }

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
