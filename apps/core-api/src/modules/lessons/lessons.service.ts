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
import { PeriodsService } from '../periods/periods.service.js';
import { businessNow } from '../../common/time/business-clock.js';

export type CreateSingleLessonInput = {
  accountId: string;
  teacherId: string;
  startsAt: Date;
  note?: string | undefined;
};

export type CreateBatchLessonsInput = {
  accountId: string;
  teacherId: string;
  firstStartsAt: Date;
  weeks: number;
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

export type SingleLessonPreview = {
  normalizedCommand: CreateSingleLessonInput & { endsAt: Date; note?: string };
  resourceVersions: {
    accountId: string;
    accountVersion: number;
    teacherId: string;
    conflicts: Array<{ id: string; version: number; startsAt: Date; endsAt: Date }>;
  };
};

export type BatchLessonPreview = {
  normalizedCommand: CreateBatchLessonsInput;
  lessons: Array<{ startsAt: Date; endsAt: Date }>;
  conflicts: Array<Record<string, string>>;
  resourceVersions: {
    accountId: string;
    accountVersion: number;
    teacherId: string;
    teacherUpdatedAt: Date;
  };
};

export type LessonMutationVersions = {
  lessonId: string;
  lessonVersion: number;
  accountId: string;
  accountVersion?: number;
  unitPrice?: string;
  consumptionEntryId?: string;
};

export type LessonConsumptionCorrectionInput = {
  correctedUnitPrice: Prisma.Decimal;
  note?: string | undefined;
};

export type LessonConsumptionCorrectionVersions = {
  lessonId: string;
  lessonVersion: number;
  accountId: string;
  accountVersion: number;
  consumptionEntryId: string;
  correctedUnitPrice: string;
};

const LESSON_SELECT = {
  id: true,
  accountId: true,
  teacherId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  version: true,
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

export type LessonReadFilters = {
  startsAt: Date;
  endsAt: Date;
  studentName?: string | undefined;
  courseName?: string | undefined;
  teacherName?: string | undefined;
  status?: LessonStatus | undefined;
};

export type LessonReadSummary = {
  id: string;
  accountId: string;
  teacherId: string;
  startsAt: Date;
  endsAt: Date;
  status: LessonStatus;
  student: { id: string; name: string };
  course: { id: string; name: string };
  teacher: { id: string; name: string };
};

const LESSON_READ_SELECT = {
  id: true,
  accountId: true,
  teacherId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  account: {
    select: {
      student: { select: { id: true, name: true } },
      course: { select: { id: true, name: true } },
    },
  },
  teacher: { select: { id: true, name: true } },
} satisfies Prisma.LessonSelect;

type LessonReadRecord = Prisma.LessonGetPayload<{ select: typeof LESSON_READ_SELECT }>;

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
      version: true,
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
  constructor(
    private readonly repository: LessonsRepository,
    private readonly periods: PeriodsService,
  ) {}

  async createBatch(input: CreateBatchLessonsInput, actor: AuthenticatedActor): Promise<LessonSummary[]> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以批量排课');
    return this.repository.transaction((tx) => this.createBatchInTransaction(tx, input, actor));
  }

  async previewBatch(input: CreateBatchLessonsInput, actor: AuthenticatedActor): Promise<BatchLessonPreview> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以批量排课');
    return this.repository.transaction((tx) => this.previewBatchInTransaction(tx, input, actor));
  }

  async createBatchInTransaction(
    tx: TransactionClient,
    input: CreateBatchLessonsInput,
    actor: AuthenticatedActor,
    expected?: BatchLessonPreview['resourceVersions'],
  ): Promise<LessonSummary[]> {
    const preview = await this.previewBatchInTransaction(tx, input, actor);
    if (expected && (
      expected.accountId !== preview.resourceVersions.accountId ||
      expected.accountVersion !== preview.resourceVersions.accountVersion ||
      expected.teacherId !== preview.resourceVersions.teacherId ||
      expected.teacherUpdatedAt.toISOString() !== preview.resourceVersions.teacherUpdatedAt.toISOString()
    )) {
      throw new ConflictException('排课资源已变化，请重新预览');
    }
    if (preview.conflicts.length > 0) {
      throw new ConflictException({ message: '批量排课存在时间冲突，未创建任何排课', conflicts: preview.conflicts });
    }

    const note = input.note?.trim() || null;
    const created: LessonSummary[] = [];
    for (const slot of preview.lessons) {
      const lesson = await tx.lesson.create({
        data: {
          accountId: input.accountId,
          teacherId: input.teacherId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          status: LessonStatus.SCHEDULED,
          note,
        },
        select: LESSON_SELECT,
      });
      created.push(toSummary(lesson));
    }
    return created;
  }

  private async previewBatchInTransaction(
    tx: TransactionClient,
    input: CreateBatchLessonsInput,
    actor: AuthenticatedActor,
  ): Promise<BatchLessonPreview> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以批量排课');
    if (!Number.isInteger(input.weeks) || input.weeks < 1 || input.weeks > 52) {
      throw new BadRequestException('批量排课周数必须为 1 至 52 的整数');
    }
    if (!Number.isFinite(input.firstStartsAt.getTime())) throw new BadRequestException('首次上课时间无效');

      const account = await tx.studentCourseAccount.findUnique({
        where: { id: input.accountId },
        include: { course: true },
      });
      if (!account) throw new NotFoundException('学生课程账户不存在');
      if (!Number.isInteger(account.course.defaultDurationMinutes) || account.course.defaultDurationMinutes < 1) {
        throw new BadRequestException('课程默认时长无效');
      }

      const teacher = await tx.teacher.findUnique({ where: { id: input.teacherId }, select: { id: true, updatedAt: true } });
      if (!teacher) throw new NotFoundException('教师不存在');

      const duration = account.course.defaultDurationMinutes * 60_000;
      const proposed = Array.from({ length: input.weeks }, (_, index) => {
        const startsAt = new Date(input.firstStartsAt.getTime() + index * 7 * 24 * 60 * 60_000);
        return { startsAt, endsAt: new Date(startsAt.getTime() + duration) };
      });
      const existing = await tx.lesson.findMany({
        where: {
          teacherId: input.teacherId,
          status: { not: LessonStatus.CANCELLED },
          startsAt: { lt: proposed.at(-1)!.endsAt },
          endsAt: { gt: proposed[0]!.startsAt },
        },
        select: { id: true, startsAt: true, endsAt: true },
      });

      const conflicts: Array<Record<string, string>> = [];
      for (const slot of proposed) {
        for (const lesson of existing) {
          if (lesson.startsAt < slot.endsAt && lesson.endsAt > slot.startsAt) {
            conflicts.push({
              startsAt: slot.startsAt.toISOString(),
              endsAt: slot.endsAt.toISOString(),
              conflictingLessonId: lesson.id,
              conflictingStartsAt: lesson.startsAt.toISOString(),
              conflictingEndsAt: lesson.endsAt.toISOString(),
            });
          }
        }
      }
      for (let index = 0; index < proposed.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < proposed.length; otherIndex += 1) {
          const slot = proposed[index]!;
          const other = proposed[otherIndex]!;
          if (other.startsAt < slot.endsAt && other.endsAt > slot.startsAt) {
            conflicts.push({
              startsAt: other.startsAt.toISOString(),
              endsAt: other.endsAt.toISOString(),
              conflictingStartsAt: slot.startsAt.toISOString(),
              conflictingEndsAt: slot.endsAt.toISOString(),
            });
          }
        }
      }
      return {
        normalizedCommand: {
          accountId: input.accountId,
          teacherId: input.teacherId,
          firstStartsAt: new Date(input.firstStartsAt),
          weeks: input.weeks,
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        },
        lessons: proposed,
        conflicts,
        resourceVersions: {
          accountId: account.id,
          accountVersion: account.version,
          teacherId: teacher.id,
          teacherUpdatedAt: teacher.updatedAt,
        },
      };
  }

  async createSingle(input: CreateSingleLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    const preview = await this.previewSingle(input, actor);
    return this.repository.transaction((tx) =>
      this.createSingleInTransaction(tx, preview.normalizedCommand, actor),
    );
  }

  async previewSingle(input: CreateSingleLessonInput, actor: AuthenticatedActor): Promise<SingleLessonPreview> {
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
    const conflicts = await this.repository.lesson.findMany({
      where: {
        teacherId: input.teacherId,
        status: { not: LessonStatus.CANCELLED },
        startsAt: { lt: endsAt },
        endsAt: { gt: input.startsAt },
      },
      select: { id: true, version: true, startsAt: true, endsAt: true },
    });
    if (conflicts.length > 0) throw new ConflictException('该教师在此时间段已有排课');
    return {
      normalizedCommand: {
        accountId: input.accountId,
        teacherId: input.teacherId,
        startsAt: input.startsAt,
        endsAt,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      },
      resourceVersions: {
        accountId: account.id,
        accountVersion: account.version,
        teacherId: input.teacherId,
        conflicts: conflicts.map((lesson) => ({
          id: lesson.id,
          version: lesson.version,
          startsAt: lesson.startsAt,
          endsAt: lesson.endsAt,
        })),
      },
    };
  }

  async createSingleInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateSingleLessonInput & { endsAt: Date },
    actor: AuthenticatedActor,
    expected?: SingleLessonPreview['resourceVersions'],
  ): Promise<LessonSummary> {
    if (actor.role === 'TEACHER') {
      if (!actor.teacherId || actor.teacherId !== input.teacherId) throw new ForbiddenException('不能为其他教师排课');
    }
    const lockedTeacher = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Teacher" WHERE "id" = ${input.teacherId} FOR UPDATE
    `;
    if (lockedTeacher.length === 0) throw new NotFoundException('授课教师不存在');
    const lockedAccount = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "StudentCourseAccount" WHERE "id" = ${input.accountId} FOR UPDATE
    `;
    if (lockedAccount.length === 0) throw new NotFoundException('学生课程账户不存在');
    const account = await tx.studentCourseAccount.findUnique({
      where: { id: input.accountId },
      include: { course: true, student: true },
    });
    if (!account) throw new NotFoundException('学生课程账户不存在');
    if (expected && (account.id !== expected.accountId || account.version !== expected.accountVersion)) {
      throw new ConflictException('排课资源已变化，请重新预览');
    }
    const endsAt = this.addDuration(input.startsAt, account.course.defaultDurationMinutes);
    if (endsAt.getTime() !== input.endsAt.getTime()) throw new ConflictException('课程或排课资源已变化，请重新预览');
    const conflicts = await tx.lesson.findMany({
      where: {
        teacherId: input.teacherId,
        status: { not: LessonStatus.CANCELLED },
        startsAt: { lt: endsAt },
        endsAt: { gt: input.startsAt },
      },
      select: { id: true },
    });
    if (conflicts.length > 0 || (expected && expected.conflicts.length > 0)) {
      throw new ConflictException('该教师在此时间段已有排课');
    }
    const lesson = await tx.lesson.create({
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

  async listForActor(actor: AuthenticatedActor, range?: { from: Date; to: Date }): Promise<LessonSummary[]> {
    const where = {
      ...(actor.role === 'OWNER' ? {} : { teacherId: actor.teacherId ?? '' }),
      ...(range ? { startsAt: { gte: range.from, lt: range.to } } : {}),
    };
    const lessons = await this.repository.lesson.findMany({
      where,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: LESSON_SELECT,
    });
    return lessons.map(toSummary);
  }

  async listForActorInRange(
    actor: AuthenticatedActor,
    filters: LessonReadFilters,
  ): Promise<LessonReadSummary[]> {
    const where = {
      ...(actor.role === 'OWNER' ? {} : { teacherId: actor.teacherId ?? '' }),
      startsAt: { gte: filters.startsAt, lt: filters.endsAt },
      ...(filters.studentName || filters.courseName ? {
        account: {
          ...(filters.studentName ? { student: { name: filters.studentName } } : {}),
          ...(filters.courseName ? { course: { name: filters.courseName } } : {}),
        },
      } : {}),
      ...(filters.teacherName ? { teacher: { name: filters.teacherName } } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };
    const lessons = await this.repository.lesson.findMany({
      where,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: LESSON_READ_SELECT,
    });
    return lessons.map((lesson: LessonReadRecord) => ({
      id: lesson.id,
      accountId: lesson.accountId,
      teacherId: lesson.teacherId,
      startsAt: lesson.startsAt,
      endsAt: lesson.endsAt,
      status: lesson.status,
      student: lesson.account.student,
      course: lesson.account.course,
      teacher: lesson.teacher,
    }));
  }

  async reschedule(id: string, input: RescheduleLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    return this.repository.transaction((tx) => this.rescheduleInTransaction(tx, id, input, actor));
  }

  async cancel(id: string, input: CancelLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    return this.repository.transaction((tx) => this.cancelInTransaction(tx, id, input, actor));
  }

  async previewReschedule(id: string, input: RescheduleLessonInput, actor: AuthenticatedActor) {
    return this.repository.transaction(async (tx) => {
      const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
      if (!lesson) throw new NotFoundException('排课不存在');
      this.assertActorCanManage(actor, lesson.teacherId);
      this.assertScheduled(lesson.status);
      const endsAt = this.addDuration(input.startsAt, lesson.account.course.defaultDurationMinutes);
      const conflict = await tx.lesson.findFirst({ where: {
        teacherId: lesson.teacherId, status: { not: LessonStatus.CANCELLED },
        startsAt: { lt: endsAt }, endsAt: { gt: input.startsAt }, id: { not: id },
      }, select: { id: true } });
      if (conflict) throw new ConflictException('该教师在此时间段已有排课');
      return {
        normalizedCommand: { lessonId: id, startsAt: input.startsAt, endsAt },
        display: { lessonId: lesson.id, studentName: lesson.account.student.name, courseName: lesson.account.course.name,
          teacherId: lesson.teacherId, previousStartsAt: lesson.startsAt, previousEndsAt: lesson.endsAt,
          startsAt: input.startsAt, endsAt },
        resourceVersions: { lessonId: id, lessonVersion: lesson.version, accountId: lesson.accountId,
          accountVersion: lesson.account.version, courseDurationMinutes: lesson.account.course.defaultDurationMinutes },
      };
    });
  }

  async rescheduleInTransaction(
    tx: TransactionClient, id: string, input: RescheduleLessonInput, actor: AuthenticatedActor,
    expected?: { lessonVersion: number; accountVersion: number; courseDurationMinutes: number; endsAt: Date },
  ): Promise<LessonSummary> {
    await this.lockLesson(tx, id);
    const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
    if (!lesson) throw new NotFoundException('排课不存在');
    this.assertActorCanManage(actor, lesson.teacherId);
    this.assertScheduled(lesson.status);
    if (expected && (lesson.version !== expected.lessonVersion || lesson.account.version !== expected.accountVersion ||
      lesson.account.course.defaultDurationMinutes !== expected.courseDurationMinutes)) {
      throw new ConflictException('排课或课程资料已变化，请重新预览');
    }
    const endsAt = this.addDuration(input.startsAt, lesson.account.course.defaultDurationMinutes);
    if (expected && endsAt.getTime() !== expected.endsAt.getTime()) throw new ConflictException('排课时长已变化，请重新预览');
    const conflict = await tx.lesson.findFirst({ where: {
      teacherId: lesson.teacherId, status: { not: LessonStatus.CANCELLED },
      startsAt: { lt: endsAt }, endsAt: { gt: input.startsAt }, id: { not: id },
    }, select: { id: true } });
    if (conflict) throw new ConflictException('该教师在此时间段已有排课');
    return toSummary(await tx.lesson.update({ where: { id }, data: {
      startsAt: input.startsAt, endsAt, version: { increment: 1 },
    }, select: LESSON_SELECT }));
  }

  async previewCancel(id: string, input: CancelLessonInput, actor: AuthenticatedActor) {
    return this.repository.transaction(async (tx) => {
      const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
      if (!lesson) throw new NotFoundException('排课不存在');
      this.assertActorCanManage(actor, lesson.teacherId);
      this.assertScheduled(lesson.status);
      return {
        normalizedCommand: { lessonId: id, note: input.note?.trim() || null },
        display: { lessonId: lesson.id, studentName: lesson.account.student.name, courseName: lesson.account.course.name,
          teacherId: lesson.teacherId, startsAt: lesson.startsAt, endsAt: lesson.endsAt, statusBefore: lesson.status,
          statusAfter: LessonStatus.CANCELLED, note: input.note?.trim() || null },
        resourceVersions: { lessonId: id, lessonVersion: lesson.version, accountId: lesson.accountId,
          accountVersion: lesson.account.version },
      };
    });
  }

  async cancelInTransaction(
    tx: TransactionClient, id: string, input: CancelLessonInput, actor: AuthenticatedActor,
    expected?: { lessonVersion: number; accountVersion: number },
  ): Promise<LessonSummary> {
    await this.lockLesson(tx, id);
    const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
    if (!lesson) throw new NotFoundException('排课不存在');
    this.assertActorCanManage(actor, lesson.teacherId);
    this.assertScheduled(lesson.status);
    if (expected && (lesson.version !== expected.lessonVersion || lesson.account.version !== expected.accountVersion)) {
      throw new ConflictException('排课资料已变化，请重新预览');
    }
    const updated = await tx.lesson.update({ where: { id }, data: {
      status: LessonStatus.CANCELLED,
      ...(input.note !== undefined ? { note: input.note.trim() || null } : {}),
      version: { increment: 1 },
    }, select: LESSON_SELECT });
    return toSummary(updated);
  }

  async complete(id: string, input: CompleteLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    try {
      return await this.repository.transaction((tx) => this.completeInTransaction(tx, id, input, actor));
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      return this.resolveCommandReplay(id, input.commandId, actor.id);
    }
  }

  async previewComplete(id: string, input: Pick<CompleteLessonInput, 'note'>, actor: AuthenticatedActor) {
    return this.repository.transaction(async (tx) => {
      const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
      if (!lesson) throw new NotFoundException('排课不存在');
      this.assertActorCanManage(actor, lesson.teacherId);
      if (lesson.status !== LessonStatus.SCHEDULED) throw new ConflictException('只有待上课排课可以确认');
      // A lesson consumption belongs to the lesson's scheduled business date,
      // not to the later moment when the owner clicks “confirm”.  This keeps a
      // closed historical month from being bypassed by confirming an old
      // lesson in the current month.
      const now = businessNow();
      const occurredAt = lesson.endsAt;
      if (now < lesson.endsAt) throw new ConflictException('课程结束后才能确认上课');
      await this.periods.assertWritableForDate(occurredAt, tx);
      if (!lesson.account.currentUnitPrice.gt(0)) throw new BadRequestException('学生课程账户单节收费金额必须大于零');
      await this.lockAccount(tx, lesson.accountId);
      const balances = await this.getBalances(tx, lesson);
      const giftConsumed = balances.gift.gt(0)
        ? (balances.gift.lt(lesson.account.currentUnitPrice) ? balances.gift : lesson.account.currentUnitPrice)
        : new Prisma.Decimal(0);
      const paidConsumed = lesson.account.currentUnitPrice.sub(giftConsumed);
      return {
        normalizedCommand: { lessonId: id, note: input.note?.trim() || null },
        display: {
          lessonId: id, studentName: lesson.account.student.name, courseName: lesson.account.course.name,
          startsAt: lesson.startsAt, endsAt: lesson.endsAt, unitPrice: lesson.account.currentUnitPrice.toFixed(2),
          paidBalanceBefore: balances.paid.toFixed(2), giftBalanceBefore: balances.gift.toFixed(2),
          paidConsumed: paidConsumed.toFixed(2), giftConsumed: giftConsumed.toFixed(2),
          paidBalanceAfter: balances.paid.sub(paidConsumed).toFixed(2), giftBalanceAfter: balances.gift.sub(giftConsumed).toFixed(2),
        },
        resourceVersions: { lessonId: id, lessonVersion: lesson.version, accountId: lesson.accountId,
          accountVersion: lesson.account.version, unitPrice: lesson.account.currentUnitPrice.toFixed(2) },
      };
    });
  }

  async completeInTransaction(
    tx: TransactionClient, id: string, input: CompleteLessonInput, actor: AuthenticatedActor,
    expected?: LessonMutationVersions,
  ): Promise<LessonSummary> {
    const replay = await this.findCommandLessonId(tx, input.commandId, actor.id);
    if (replay) return this.getLessonWithClient(tx, replay, id);
    await this.lockLesson(tx, id);
    let lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
    if (!lesson) throw new NotFoundException('排课不存在');
    this.assertActorCanManage(actor, lesson.teacherId);
    if (lesson.status !== LessonStatus.SCHEDULED) throw new ConflictException('只有待上课排课可以确认');
    if (expected && (lesson.version !== expected.lessonVersion || lesson.account.version !== expected.accountVersion)) {
      throw new ConflictException('排课或课程账户已变化，请重新预览');
    }
    const completedAt = businessNow();
    if (completedAt < lesson.endsAt) throw new ConflictException('课程结束后才能确认上课');
    // The completion timestamp is an audit timestamp; the ledger's business
    // date is the scheduled lesson end used by the preview above.
    const occurredAt = lesson.endsAt;
    await this.periods.assertWritableForDate(occurredAt, tx);
    await this.lockAccount(tx, lesson.accountId);
    const account = await tx.studentCourseAccount.findUnique({ where: { id: lesson.accountId }, select: {
      version: true, currentUnitPrice: true,
    } });
    if (!account || (expected && (account.version !== expected.accountVersion || account.currentUnitPrice.toFixed(2) !== expected.unitPrice))) {
      throw new ConflictException('课程账户已变化，请重新预览');
    }
    if (!account.currentUnitPrice.gt(0)) throw new BadRequestException('学生课程账户单节收费金额必须大于零');
    lesson = { ...lesson, account: { ...lesson.account, currentUnitPrice: account.currentUnitPrice } };
    const balances = await this.getBalances(tx, lesson);
    const giftConsumed = balances.gift.gt(0)
      ? (balances.gift.lt(account.currentUnitPrice) ? balances.gift : account.currentUnitPrice)
      : new Prisma.Decimal(0);
    const paidConsumed = account.currentUnitPrice.sub(giftConsumed);
    await tx.ledgerEntry.create({ data: {
      accountId: lesson.accountId, lessonId: lesson.id, kind: LedgerEntryKind.LESSON_CONSUMPTION,
      paidDelta: paidConsumed.negated(), giftDelta: giftConsumed.negated(), occurredAt,
      note: input.note?.trim() || null, createdById: actor.id, commandId: input.commandId,
    } });
    const completed = await tx.lesson.update({ where: { id }, data: {
      status: LessonStatus.COMPLETED, unitPriceSnapshot: account.currentUnitPrice, completedAt,
      completedById: actor.id, version: { increment: 1 },
    }, select: LESSON_SELECT });
    await this.incrementAccountVersion(tx, lesson.accountId);
    return toSummary(completed);
  }

  async reverseCompletion(id: string, input: CompleteLessonInput, actor: AuthenticatedActor): Promise<LessonSummary> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以撤销上课确认');
    try {
      return await this.repository.transaction((tx) => this.reverseCompletionInTransaction(tx, id, input, actor));
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      return this.resolveCommandReplay(id, input.commandId, actor.id);
    }
  }

  async previewReverseCompletion(id: string, input: Pick<CompleteLessonInput, 'note'>, actor: AuthenticatedActor) {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以撤销上课确认');
    return this.repository.transaction(async (tx) => {
      const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
      if (!lesson) throw new NotFoundException('排课不存在');
      if (lesson.status !== LessonStatus.COMPLETED) throw new ConflictException('只有已完成排课可以撤销确认');
      const consumption = await tx.ledgerEntry.findUnique({ where: { lessonId: id },
        select: { id: true, accountId: true, paidDelta: true, giftDelta: true } });
      if (!consumption) throw new ConflictException('课程消费流水不存在');
      const existingReversal = await tx.ledgerEntry.findUnique({ where: { reversesEntryId: consumption.id }, select: { id: true } });
      if (existingReversal) throw new ConflictException('该课程确认已撤销');
      return {
        normalizedCommand: { lessonId: id, note: input.note?.trim() || null },
        display: { lessonId: id, studentName: lesson.account.student.name, courseName: lesson.account.course.name,
          startsAt: lesson.startsAt, endsAt: lesson.endsAt, paidRestore: consumption.paidDelta.negated().toFixed(2),
          giftRestore: consumption.giftDelta.negated().toFixed(2), statusBefore: lesson.status, statusAfter: LessonStatus.SCHEDULED },
        resourceVersions: { lessonId: id, lessonVersion: lesson.version, accountId: lesson.accountId,
          accountVersion: lesson.account.version, consumptionEntryId: consumption.id },
      };
    });
  }

  async reverseCompletionInTransaction(
    tx: TransactionClient, id: string, input: CompleteLessonInput, actor: AuthenticatedActor,
    expected?: LessonMutationVersions,
  ): Promise<LessonSummary> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以撤销上课确认');
    const replay = await this.findCommandLessonId(tx, input.commandId, actor.id);
    if (replay) return this.getLessonWithClient(tx, replay, id);
    await this.lockLesson(tx, id);
    const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
    if (!lesson) throw new NotFoundException('排课不存在');
    if (lesson.status !== LessonStatus.COMPLETED) throw new ConflictException('只有已完成排课可以撤销确认');
    if (expected && (lesson.version !== expected.lessonVersion || lesson.account.version !== expected.accountVersion)) {
      throw new ConflictException('课程状态或账户余额已变化，请重新预览');
    }
    const consumption = await tx.ledgerEntry.findUnique({ where: { lessonId: id },
      select: { id: true, accountId: true, paidDelta: true, giftDelta: true } });
    if (!consumption || (expected && consumption.id !== expected.consumptionEntryId)) {
      throw new ConflictException('课程消费流水已变化，请重新预览');
    }
    await this.lockAccount(tx, lesson.accountId);
    const existingReversal = await tx.ledgerEntry.findUnique({ where: { reversesEntryId: consumption.id }, select: { id: true } });
    if (existingReversal) throw new ConflictException('该课程确认已撤销');
    const occurredAt = businessNow();
    await this.periods.assertWritableForDate(occurredAt, tx);
    await tx.ledgerEntry.create({ data: {
      accountId: consumption.accountId, kind: LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL,
      paidDelta: consumption.paidDelta.negated(), giftDelta: consumption.giftDelta.negated(), occurredAt,
      note: input.note?.trim() || null, createdById: actor.id, commandId: input.commandId, reversesEntryId: consumption.id,
    } });
    const restored = await tx.lesson.update({ where: { id }, data: {
      status: LessonStatus.SCHEDULED, unitPriceSnapshot: null, completedAt: null, completedById: null,
      version: { increment: 1 },
    }, select: LESSON_SELECT });
    await this.incrementAccountVersion(tx, lesson.accountId);
    return toSummary(restored);
  }

  async previewCompletionCorrection(
    id: string,
    input: LessonConsumptionCorrectionInput,
    actor: AuthenticatedActor,
  ) {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以纠正历史课消');
    if (!input.correctedUnitPrice.isFinite() || !input.correctedUnitPrice.gt(0)) {
      throw new BadRequestException('纠正后的单节金额必须大于零');
    }
    return this.repository.transaction(async (tx) => {
      const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
      if (!lesson) throw new NotFoundException('排课不存在');
      if (lesson.status !== LessonStatus.COMPLETED) throw new ConflictException('只有已完成课程可以纠正课消');
      const consumption = await tx.ledgerEntry.findUnique({ where: { lessonId: id }, select: {
        id: true, accountId: true, kind: true, paidDelta: true, giftDelta: true,
      } });
      if (!consumption || consumption.kind !== LedgerEntryKind.LESSON_CONSUMPTION) {
        throw new ConflictException('原课消流水不存在或类型不正确');
      }
      const [existingReversal, existingCorrection] = await Promise.all([
        tx.ledgerEntry.findUnique({ where: { reversesEntryId: consumption.id }, select: { id: true } }),
        tx.ledgerEntry.findUnique({ where: { correctsEntryId: consumption.id }, select: { id: true } }),
      ]);
      if (existingReversal || existingCorrection) throw new ConflictException('该历史课消已处理，不能重复纠正');
      const occurredAt = businessNow();
      await this.periods.assertWritableForDate(occurredAt, tx);
      const originalGift = consumption.giftDelta.negated();
      const correctedGift = originalGift.gt(input.correctedUnitPrice) ? input.correctedUnitPrice : originalGift;
      const correctedPaid = input.correctedUnitPrice.sub(correctedGift);
      return {
        normalizedCommand: {
          lessonId: id,
          correctedUnitPrice: input.correctedUnitPrice.toFixed(2),
          note: input.note?.trim() || null,
        },
        display: {
          lessonId: id,
          studentName: lesson.account.student.name,
          courseName: lesson.account.course.name,
          startsAt: lesson.startsAt,
          endsAt: lesson.endsAt,
          statusBefore: lesson.status,
          statusAfter: LessonStatus.COMPLETED,
          originalAmount: consumption.paidDelta.add(consumption.giftDelta).negated().toFixed(2),
          correctedAmount: input.correctedUnitPrice.toFixed(2),
          reversalPaid: consumption.paidDelta.negated().toFixed(2),
          reversalGift: consumption.giftDelta.negated().toFixed(2),
          correctedPaid: correctedPaid.toFixed(2),
          correctedGift: correctedGift.toFixed(2),
          correctionOccurredAt: occurredAt,
          note: input.note?.trim() || null,
        },
        resourceVersions: {
          lessonId: id,
          lessonVersion: lesson.version,
          accountId: lesson.accountId,
          accountVersion: lesson.account.version,
          consumptionEntryId: consumption.id,
          correctedUnitPrice: input.correctedUnitPrice.toFixed(2),
        } satisfies LessonConsumptionCorrectionVersions,
      };
    });
  }

  async correctCompletionAmount(
    id: string,
    input: LessonConsumptionCorrectionInput & { commandId: string },
    actor: AuthenticatedActor,
  ): Promise<LessonSummary> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以纠正历史课消');
    try {
      return await this.repository.transaction((tx) => this.correctCompletionAmountInTransaction(tx, id, input, actor));
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      return this.resolveCommandReplay(id, input.commandId, actor.id);
    }
  }

  async correctCompletionAmountInTransaction(
    tx: TransactionClient,
    id: string,
    input: LessonConsumptionCorrectionInput & { commandId: string },
    actor: AuthenticatedActor,
    expected?: LessonConsumptionCorrectionVersions,
  ): Promise<LessonSummary> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以纠正历史课消');
    if (!input.correctedUnitPrice.isFinite() || !input.correctedUnitPrice.gt(0)) {
      throw new BadRequestException('纠正后的单节金额必须大于零');
    }
    const replay = await this.findCommandLessonId(tx, input.commandId, actor.id);
    if (replay) return this.getLessonWithClient(tx, replay, id);
    await this.lockLesson(tx, id);
    const lesson = await tx.lesson.findUnique({ where: { id }, select: COMPLETION_LESSON_SELECT });
    if (!lesson) throw new NotFoundException('排课不存在');
    if (lesson.status !== LessonStatus.COMPLETED) throw new ConflictException('只有已完成课程可以纠正课消');
    if (expected && (lesson.version !== expected.lessonVersion || lesson.account.version !== expected.accountVersion)) {
      throw new ConflictException('课程或课程账户已变化，请重新预览');
    }
    const consumption = await tx.ledgerEntry.findUnique({ where: { lessonId: id }, select: {
      id: true, accountId: true, kind: true, paidDelta: true, giftDelta: true,
    } });
    if (!consumption || consumption.kind !== LedgerEntryKind.LESSON_CONSUMPTION) {
      throw new ConflictException('原课消流水不存在或类型不正确');
    }
    if (expected && consumption.id !== expected.consumptionEntryId) throw new ConflictException('原课消流水已变化，请重新预览');
    if (expected && expected.correctedUnitPrice !== input.correctedUnitPrice.toFixed(2)) throw new ConflictException('纠正金额已变化，请重新预览');
    await this.lockAccount(tx, lesson.accountId);
    const [existingReversal, existingCorrection] = await Promise.all([
      tx.ledgerEntry.findUnique({ where: { reversesEntryId: consumption.id }, select: { id: true } }),
      tx.ledgerEntry.findUnique({ where: { correctsEntryId: consumption.id }, select: { id: true } }),
    ]);
    if (existingReversal || existingCorrection) throw new ConflictException('该历史课消已处理，不能重复纠正');
    const occurredAt = businessNow();
    await this.periods.assertWritableForDate(occurredAt, tx);
    const originalGift = consumption.giftDelta.negated();
    const correctedGift = originalGift.gt(input.correctedUnitPrice) ? input.correctedUnitPrice : originalGift;
    const correctedPaid = input.correctedUnitPrice.sub(correctedGift);
    await tx.ledgerEntry.create({ data: {
      accountId: consumption.accountId, kind: LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL,
      paidDelta: consumption.paidDelta.negated(), giftDelta: consumption.giftDelta.negated(), occurredAt,
      note: input.note?.trim() || null, createdById: actor.id, commandId: `${input.commandId}:reversal`, reversesEntryId: consumption.id,
    } });
    await tx.ledgerEntry.create({ data: {
      accountId: consumption.accountId, kind: LedgerEntryKind.LESSON_CONSUMPTION_CORRECTION,
      paidDelta: correctedPaid.negated(), giftDelta: correctedGift.negated(), occurredAt,
      note: input.note?.trim() || null, createdById: actor.id, commandId: input.commandId, correctsEntryId: consumption.id,
    } });
    const corrected = await tx.lesson.update({ where: { id }, data: {
      unitPriceSnapshot: input.correctedUnitPrice, version: { increment: 1 },
    }, select: LESSON_SELECT });
    await this.incrementAccountVersion(tx, lesson.accountId);
    return toSummary(corrected);
  }

  private async resolveCommandReplay(id: string, commandId: string, actorId: string): Promise<LessonSummary> {
    const replay = await this.repository.ledgerEntry.findUnique({
      where: { commandId },
      select: {
        createdById: true,
        lessonId: true,
        reversesEntry: { select: { lessonId: true } },
        correctsEntry: { select: { lessonId: true } },
      },
    });
    if (!replay) throw new ConflictException('命令重复提交，请使用新的幂等键重试');
    if (replay.createdById !== actorId) throw new ConflictException('幂等键已被其他用户使用');
    const replayLessonId = replay.lessonId ?? replay.reversesEntry?.lessonId ?? replay.correctsEntry?.lessonId;
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
        correctsEntry: { select: { lessonId: true } },
      },
    });
    if (!replay) return undefined;
    if (replay.createdById !== actorId) throw new ConflictException('幂等键已被其他用户使用');
    const lessonId = replay.lessonId ?? replay.reversesEntry?.lessonId ?? replay.correctsEntry?.lessonId;
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
