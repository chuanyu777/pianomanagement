import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LedgerEntryKind, LessonStatus, Prisma } from '../../generated/prisma/client.js';
import type { AuthenticatedActor } from '../auth/auth.types.js';
import { LessonsRepository } from './lessons.repository.js';

export type CreateSingleLessonInput = {
  accountId: string;
  teacherId: string;
  startsAt: Date;
  note?: string | undefined;
};

export type RescheduleLessonInput = {
  startsAt: Date;
};

export type CancelLessonInput = {
  note?: string | undefined;
};

export type CompleteLessonInput = {
  commandId: string;
  note?: string | undefined;
};

const LESSON_SELECT = {
  id: true,
  accountId: true,
  teacherId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  note: true,
  unitPriceSnapshot: true,
  completedAt: true,
  account: {
    select: {
      student: { select: { id: true, name: true } },
      course: { select: { id: true, name: true, defaultDurationMinutes: true } },
    },
  },
} satisfies Prisma.LessonSelect;

type LessonRecord = Prisma.LessonGetPayload<{ select: typeof LESSON_SELECT }>;
export type LessonSummary = {
  id: string;
  accountId: string;
  teacherId: string;
  startsAt: Date;
  endsAt: Date;
  status: LessonStatus;
  note: string | null;
  unitPriceSnapshot: string | null;
  completedAt: Date | null;
  student: { id: string; name: string };
  course: { id: string; name: string };
};

function toSummary(lesson: LessonRecord): LessonSummary {
  return {
    id: lesson.id,
    accountId: lesson.accountId,
    teacherId: lesson.teacherId,
    startsAt: lesson.startsAt,
    endsAt: lesson.endsAt,
    status: lesson.status,
    note: lesson.note,
    unitPriceSnapshot: lesson.unitPriceSnapshot?.toFixed(2) ?? null,
    completedAt: lesson.completedAt,
    student: lesson.account.student,
    course: {
      id: lesson.account.course.id,
      name: lesson.account.course.name,
    },
  };
}

const COMPLETION_LESSON_SELECT = {
  ...LESSON_SELECT,
  account: {
    select: {
      student: { select: { id: true, name: true } },
      course: { select: { id: true, name: true, defaultDurationMinutes: true } },
      currentUnitPrice: true,
      openingPaidBalance: true,
      openingGiftBalance: true,
    },
  },
} satisfies Prisma.LessonSelect;

type CompletionLesson = Prisma.LessonGetPayload<{ select: typeof COMPLETION_LESSON_SELECT }>;
type TransactionClient = Prisma.TransactionClient;

function canAccess(actor: AuthenticatedActor, teacherId: string): boolean {
  return actor.role === 'OWNER' || (actor.role === 'TEACHER' && actor.teacherId === teacherId);
}

@Injectable()
export class LessonsService {
  constructor(private readonly repository: LessonsRepository) {}

  async createSingle(input: CreateSingleLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    if (actor.role === 'TEACHER') {
      if (!actor.teacherId) throw new ForbiddenException('教师账号未关联教师资料');
      if (actor.teacherId !== input.teacherId) throw new ForbiddenException('不能为其他教师排课');
    }

    const account = await this.repository.studentCourseAccount.findUnique({
      where: { id: input.accountId },
      include: { course: true, student: true },
    });
    if (!account) throw new NotFoundException('学生课程账户不存在');

    const endsAt = this.addDuration(input.startsAt, account.course.defaultDurationMinutes);
    await this.assertNoOverlap(input.teacherId, input.startsAt, endsAt);
    const lesson = await this.repository.lesson.create({
      data: {
        accountId: input.accountId,
        teacherId: input.teacherId,
        startsAt: input.startsAt,
        endsAt,
        status: LessonStatus.SCHEDULED,
        note: input.note?.trim() || null,
      },
      select: LESSON_SELECT,
    });
    return toSummary(lesson);
  }

  async listForActor(actor: AuthenticatedActor): Promise<LessonSummary[]> {
    const where = actor.role === 'OWNER'
      ? {}
      : { teacherId: actor.teacherId ?? '' };
    const lessons = await this.repository.lesson.findMany({
      where,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: LESSON_SELECT,
    });
    return lessons.map(toSummary);
  }

  async reschedule(id: string, input: RescheduleLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    const lesson = await this.getLesson(id);
    this.assertActorCanManage(actor, lesson.teacherId);
    this.assertScheduled(lesson.status);
    const endsAt = this.addDuration(input.startsAt, lesson.account.course.defaultDurationMinutes);
    await this.assertNoOverlap(lesson.teacherId, input.startsAt, endsAt, id);
    const updated = await this.repository.lesson.update({
      where: { id },
      data: { startsAt: input.startsAt, endsAt, version: { increment: 1 } },
      select: LESSON_SELECT,
    });
    return toSummary(updated);
  }

  async cancel(id: string, input: CancelLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    const lesson = await this.getLesson(id);
    this.assertActorCanManage(actor, lesson.teacherId);
    this.assertScheduled(lesson.status);
    const updated = await this.repository.lesson.update({
      where: { id },
      data: {
        status: LessonStatus.CANCELLED,
        ...(input.note !== undefined ? { note: input.note.trim() || null } : {}),
        version: { increment: 1 },
      },
      select: LESSON_SELECT,
    });
    return toSummary(updated);
  }

  async complete(id: string, input: CompleteLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    try {
      return await this.repository.transaction(async (tx) => {
        const replay = await this.findCommandLessonId(tx, input.commandId, actor.id);
        if (replay) return this.getLessonWithClient(tx, replay, id);

        await this.lockLesson(tx, id);
        const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
        if (!lesson) throw new NotFoundException('排课不存在');
        this.assertActorCanManage(actor, lesson.teacherId);
        if (lesson.status !== LessonStatus.SCHEDULED) throw new ConflictException('只有待上课排课可以确认');
        const completedAt = new Date();
        if (completedAt < lesson.endsAt) throw new ConflictException('课程结束后才能确认上课');
        if (!lesson.account.currentUnitPrice.gt(0)) throw new BadRequestException('学生课程账户单节收费金额必须大于零');

        await this.lockAccount(tx, lesson.accountId);
        const balances = await this.getBalances(tx, lesson);
        const giftConsumed = balances.gift.gt(0)
          ? (balances.gift.lt(lesson.account.currentUnitPrice) ? balances.gift : lesson.account.currentUnitPrice)
          : new Prisma.Decimal(0);
        const paidConsumed = lesson.account.currentUnitPrice.sub(giftConsumed);

        await tx.ledgerEntry.create({
          data: {
            accountId: lesson.accountId,
            lessonId: lesson.id,
            kind: LedgerEntryKind.LESSON_CONSUMPTION,
            paidDelta: paidConsumed.negated(),
            giftDelta: giftConsumed.negated(),
            occurredAt: completedAt,
            note: input.note?.trim() || null,
            createdById: actor.id,
            commandId: input.commandId,
          },
        });
        const completed = await tx.lesson.update({
          where: { id },
          data: {
            status: LessonStatus.COMPLETED,
            unitPriceSnapshot: lesson.account.currentUnitPrice,
            completedAt,
            completedById: actor.id,
            version: { increment: 1 },
          },
          select: LESSON_SELECT,
        });
        await this.incrementAccountVersion(tx, lesson.accountId);
        return toSummary(completed);
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      return this.resolveCommandReplay(id, input.commandId, actor.id);
    }
  }

  async reverseCompletion(id: string, input: CompleteLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以撤销上课确认');
    try {
      return await this.repository.transaction(async (tx) => {
        const replay = await this.findCommandLessonId(tx, input.commandId, actor.id);
        if (replay) return this.getLessonWithClient(tx, replay, id);

        await this.lockLesson(tx, id);
        const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
        if (!lesson) throw new NotFoundException('排课不存在');
        if (lesson.status !== LessonStatus.COMPLETED) throw new ConflictException('只有已完成排课可以撤销确认');
        const consumption = await tx.ledgerEntry.findUnique({
          where: { lessonId: id },
          select: { id: true, accountId: true, paidDelta: true, giftDelta: true },
        });
        if (!consumption) throw new ConflictException('课程消费流水不存在');

        await this.lockAccount(tx, lesson.accountId);
        const existingReversal = await tx.ledgerEntry.findUnique({
          where: { reversesEntryId: consumption.id },
          select: { id: true },
        });
        if (existingReversal) throw new ConflictException('该课程确认已撤销');
        const occurredAt = new Date();
        await tx.ledgerEntry.create({
          data: {
            accountId: consumption.accountId,
            kind: LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL,
            paidDelta: consumption.paidDelta.negated(),
            giftDelta: consumption.giftDelta.negated(),
            occurredAt,
            note: input.note?.trim() || null,
            createdById: actor.id,
            commandId: input.commandId,
            reversesEntryId: consumption.id,
          },
        });
        const restored = await tx.lesson.update({
          where: { id },
          data: {
            status: LessonStatus.SCHEDULED,
            unitPriceSnapshot: null,
            completedAt: null,
            completedById: null,
            version: { increment: 1 },
          },
          select: LESSON_SELECT,
        });
        await this.incrementAccountVersion(tx, lesson.accountId);
        return toSummary(restored);
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      return this.resolveCommandReplay(id, input.commandId, actor.id);
    }
  }

  private async resolveCommandReplay(id: string, commandId: string, actorId: string): Promise<LessonSummary> {
    const replay = await this.repository.ledgerEntry.findUnique({
      where: { commandId },
      select: {
        createdById: true,
        lessonId: true,
        reversesEntry: { select: { lessonId: true } },
      },
    });
    if (!replay) throw new ConflictException('命令重复提交，请使用新的幂等键重试');
    if (replay.createdById !== actorId) throw new ConflictException('幂等键已被其他用户使用');
    const replayLessonId = replay.lessonId ?? replay.reversesEntry?.lessonId;
    if (replayLessonId !== id) throw new ConflictException('幂等键已用于其他业务操作');
    return toSummary(await this.getLesson(id));
  }

  private async findCommandLessonId(
    tx: Pick<TransactionClient, 'ledgerEntry'>,
    commandId: string,
    actorId: string,
  ): Promise<string | undefined> {
    const replay = await tx.ledgerEntry.findUnique({
      where: { commandId },
      select: {
        createdById: true,
        lessonId: true,
        reversesEntry: { select: { lessonId: true } },
      },
    });
    if (!replay) return undefined;
    if (replay.createdById !== actorId) throw new ConflictException('幂等键已被其他用户使用');
    const lessonId = replay.lessonId ?? replay.reversesEntry?.lessonId;
    if (!lessonId) throw new ConflictException('幂等键已用于其他业务操作');
    return lessonId;
  }

  private async getLessonWithClient(
    tx: Pick<TransactionClient, 'lesson'>,
    replayLessonId: string,
    requestedLessonId: string,
  ): Promise<LessonSummary> {
    if (replayLessonId !== requestedLessonId) throw new ConflictException('幂等键已用于其他业务操作');
    const lesson = await tx.lesson.findUnique({ where: { id: replayLessonId }, select: LESSON_SELECT });
    if (!lesson) throw new NotFoundException('排课不存在');
    return toSummary(lesson);
  }

  private async lockLesson(tx: Pick<TransactionClient, '$queryRaw'>, lessonId: string): Promise<void> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Lesson" WHERE "id" = ${lessonId} FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundException('排课不存在');
  }

  private async lockAccount(tx: Pick<TransactionClient, '$queryRaw'>, accountId: string): Promise<void> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "StudentCourseAccount" WHERE "id" = ${accountId} FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundException('学生课程账户不存在');
  }

  private async incrementAccountVersion(
    tx: Pick<TransactionClient, 'studentCourseAccount'>,
    accountId: string,
  ): Promise<void> {
    await tx.studentCourseAccount.update({
      where: { id: accountId },
      data: { version: { increment: 1 } },
      select: { id: true },
    });
  }

  private async getBalances(
    tx: Pick<TransactionClient, 'ledgerEntry'>,
    lesson: CompletionLesson,
  ): Promise<{ paid: Prisma.Decimal; gift: Prisma.Decimal }> {
    const entries = await tx.ledgerEntry.findMany({
      where: { accountId: lesson.accountId },
      select: { paidDelta: true, giftDelta: true },
    });
    return entries.reduce(
      (balances, entry) => ({
        paid: balances.paid.add(entry.paidDelta),
        gift: balances.gift.add(entry.giftDelta),
      }),
      {
        paid: lesson.account.openingPaidBalance,
        gift: lesson.account.openingGiftBalance,
      },
    );
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private async getLesson(id: string) {
    const lesson = await this.repository.lesson.findUnique({
      where: { id },
      select: {
        ...LESSON_SELECT,
        account: {
          select: {
            ...LESSON_SELECT.account.select,
          },
        },
      },
    });
    if (!lesson) throw new NotFoundException('排课不存在');
    return lesson;
  }

  private assertActorCanManage(actor: AuthenticatedActor, teacherId: string): void {
    if (!canAccess(actor, teacherId)) throw new ForbiddenException('无权操作其他教师的排课');
  }

  private assertScheduled(status: LessonStatus): void {
    if (status !== LessonStatus.SCHEDULED) throw new ConflictException('只有待上课排课可以改期或取消');
  }

  private async assertNoOverlap(teacherId: string, startsAt: Date, endsAt: Date, excludeId?: string): Promise<void> {
    const existing = await this.repository.lesson.findFirst({
      where: {
        teacherId,
        status: { not: LessonStatus.CANCELLED },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) throw new ConflictException('该教师在此时间段已有排课');
  }

  private addDuration(startsAt: Date, durationMinutes: number): Date {
    return new Date(startsAt.getTime() + durationMinutes * 60_000);
  }
}
