import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { money, ZERO, type Money } from '../../common/money.js';
import {
  ConsumptionOrder,
  LedgerKind,
  LessonStatus,
  Prisma,
  UserRole,
} from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { computeEnrollmentBalances, splitConsumption } from '../ledger/balance.js';
import { PeriodsService } from '../periods/periods.service.js';
import { CreateLessonDto } from './dto/create-lesson.dto.js';
import { ListLessonsQueryDto } from './dto/list-lessons.dto.js';
import { UpdateLessonDto } from './dto/update-lesson.dto.js';

/** Prisma 唯一约束冲突错误码。回冲撞 reversesEntryId 唯一约束时用它转成可读 409。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/** 取消 / 请假只落到这两个终态。枚举是 const+type 形态，类型位要用 typeof 取字面量。 */
type TerminalStatus = typeof LessonStatus.LEAVE | typeof LessonStatus.CANCELLED;

/**
 * 排课与上课确认（US-SC-01/02、US-CC-01/02/03）。
 *
 * 这是全系统「钱」的核心路径，三条不变量写死在这里：
 * 1. 扣减**只在确认时发生**，金额取确认时刻的 enrollment.unitPrice 快照；
 *    赠送课取 GiftGrant.unitPrice 快照（不受后续改价影响）。
 * 2. 扣池顺序 / 拆池不在这里重写，一律调 ledger/balance.ts 的
 *    `computeEnrollmentBalances` + `splitConsumption` —— 自己写 SUM 就是第二份实现。
 * 3. 台账只追加：取消 / 请假用一条反向 CONSUMPTION_REVERSAL 回冲，**绝不 UPDATE 原流水**。
 */
@Injectable()
export class LessonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
  ) {}

  // ── 排课 CRUD（US-SC-01 / US-SC-02，仅店主） ───────────────────────────────

  async list(query: ListLessonsQueryDto) {
    const where: Prisma.LessonWhereInput = {};
    if (query.teacherId !== undefined) where.teacherId = query.teacherId;
    if (query.from !== undefined || query.to !== undefined) {
      const scheduledAt: Prisma.DateTimeFilter = {};
      if (query.from !== undefined) scheduledAt.gte = new Date(query.from);
      if (query.to !== undefined) scheduledAt.lte = new Date(query.to);
      where.scheduledAt = scheduledAt;
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.lesson.findMany({
        where,
        orderBy: { scheduledAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.lesson.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getById(id: string) {
    const found = await this.prisma.lesson.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('排课不存在');
    return found;
  }

  async create(dto: CreateLessonDto) {
    // 排课必须绑定到一条报名关系：学生 + 老师 + 课程 三者共同确定。
    const enrollment = await this.prisma.enrollment.findUnique({
      where: {
        enrollment_identity: {
          studentId: dto.studentId,
          teacherId: dto.teacherId,
          courseTypeId: dto.courseTypeId,
        },
      },
    });
    if (!enrollment) {
      throw new BadRequestException('该学生与这位老师在这门课程下还没有报名关系，请先报名');
    }

    const scheduledAt = new Date(dto.scheduledAt);
    await this.assertNoTeacherConflict(dto.teacherId, scheduledAt);

    let giftGrantId: string | null = null;
    if (dto.isGift === true) {
      await this.assertGiftGrantUsable(dto.giftGrantId, enrollment.id);
      giftGrantId = dto.giftGrantId ?? null;
    }

    return this.prisma.lesson.create({
      data: {
        enrollmentId: enrollment.id,
        studentId: enrollment.studentId,
        teacherId: enrollment.teacherId,
        courseTypeId: enrollment.courseTypeId,
        scheduledAt,
        isGift: dto.isGift ?? false,
        giftGrantId,
        note: dto.note ?? null,
      },
    });
  }

  async update(id: string, dto: UpdateLessonDto) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id } });
    if (!lesson) throw new NotFoundException('排课不存在');

    const touchesSchedule =
      dto.scheduledAt !== undefined ||
      dto.courseTypeId !== undefined ||
      dto.isGift !== undefined ||
      dto.giftGrantId !== undefined;

    // 已确认的课不能直接改时间 / 课程 / 赠送属性 —— 改完会和已入账的流水对不上。
    // 要改必须先取消（取消会走回冲），这是 US-SC-02 的硬约束。
    if (touchesSchedule && lesson.status !== LessonStatus.SCHEDULED) {
      throw new ConflictException(
        '只有待排课（SCHEDULED）状态的课能改时间 / 课程；已确认的课请先取消（会自动回冲），已取消 / 请假的课不能修改',
      );
    }

    const data: {
      scheduledAt?: Date;
      courseTypeId?: string;
      enrollmentId?: string;
      isGift?: boolean;
      giftGrantId?: string | null;
      note?: string | null;
    } = {};

    let enrollmentId = lesson.enrollmentId;
    let enrollmentChanged = false;

    // 改课程 = 换一条报名关系：用 (学生, 老师, 新课程) 重新定位 Enrollment，
    // 否则 Lesson.enrollmentId 会和新 courseTypeId 指向的报名关系不一致。
    if (dto.courseTypeId !== undefined && dto.courseTypeId !== lesson.courseTypeId) {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: {
          enrollment_identity: {
            studentId: lesson.studentId,
            teacherId: lesson.teacherId,
            courseTypeId: dto.courseTypeId,
          },
        },
      });
      if (!enrollment) {
        throw new BadRequestException('该学生与这位老师在这门课程下还没有报名关系，请先报名');
      }
      enrollmentId = enrollment.id;
      enrollmentChanged = true;
      data.courseTypeId = dto.courseTypeId;
      data.enrollmentId = enrollment.id;
    }

    if (dto.scheduledAt !== undefined) {
      const scheduledAt = new Date(dto.scheduledAt);
      await this.assertNoTeacherConflict(lesson.teacherId, scheduledAt, id);
      data.scheduledAt = scheduledAt;
    }

    // 只在赠送相关字段或报名关系真的变动时才重新校验额度 ——
    // 否则「只改备注」也会去数一遍 CONFIRMED，遇到额度恰好被别的课用满就误报 409。
    const giftTouched =
      dto.isGift !== undefined || dto.giftGrantId !== undefined || enrollmentChanged;
    const effectiveIsGift = dto.isGift ?? lesson.isGift;
    if (effectiveIsGift && giftTouched) {
      const grantId = dto.giftGrantId !== undefined ? dto.giftGrantId : lesson.giftGrantId;
      await this.assertGiftGrantUsable(grantId, enrollmentId);
      data.giftGrantId = grantId ?? null;
    } else if (dto.isGift === false) {
      // 改回非赠送课时清掉赠送额度引用，避免留下误导性的关联。
      data.giftGrantId = null;
    }
    if (dto.isGift !== undefined) data.isGift = dto.isGift;
    if (dto.note !== undefined) data.note = dto.note;

    return this.prisma.lesson.update({ where: { id }, data });
  }

  // ── 待确认列表（US-CC-01） ────────────────────────────────────────────────

  /** 跨模块接口：某位老师本人、待确认（SCHEDULED）的课。 */
  listPendingForTeacher(teacherId: string) {
    return this.prisma.lesson.findMany({
      where: { teacherId, status: LessonStatus.SCHEDULED },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  /** 待确认列表入口：老师在 service 层被强制限定为自己名下的课。 */
  async listPending(actor: AuthenticatedUser, requestedTeacherId?: string) {
    if (actor.role === UserRole.TEACHER) {
      const ownTeacherId = await this.getActorTeacherId(actor.id);
      if (!ownTeacherId) {
        throw new ForbiddenException('当前账号未关联老师档案，无法查看待确认课');
      }
      if (requestedTeacherId !== undefined && requestedTeacherId !== ownTeacherId) {
        throw new ForbiddenException('只能查看自己的待确认课');
      }
      return this.listPendingForTeacher(ownTeacherId);
    }

    if (requestedTeacherId !== undefined) {
      return this.listPendingForTeacher(requestedTeacherId);
    }
    return this.prisma.lesson.findMany({
      where: { status: LessonStatus.SCHEDULED },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  // ── 上课确认（US-CC-03）：写扣减流水 ──────────────────────────────────────

  async confirm(lessonId: string, actor: AuthenticatedUser) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw new NotFoundException('排课不存在');
    await this.assertTeacherOwnsLesson(actor, lesson);

    if (lesson.status !== LessonStatus.SCHEDULED) {
      throw new ConflictException('只有待排课（SCHEDULED）状态的课能被确认');
    }

    const confirmedAt = new Date();
    // 课时归属月份由 confirmedAt 决定；该月已关账就不能再写。
    await this.periods.assertOpenForDate(confirmedAt);

    return this.prisma.$transaction(async (tx) => {
      const enrollment = await tx.enrollment.findUnique({ where: { id: lesson.enrollmentId } });
      if (!enrollment) throw new NotFoundException('报名关系不存在');

      let paidDelta: Money;
      let giftDelta: Money;
      let giftGrantId: string | null = null;

      if (lesson.isGift) {
        // 赠送课：扣减金额取赠送时的快照单价，不取当前 enrollment.unitPrice。
        const grant = lesson.giftGrantId
          ? await tx.giftGrant.findUnique({ where: { id: lesson.giftGrantId } })
          : null;
        if (!grant) throw new BadRequestException('赠送课缺少有效的赠送额度，无法确认');
        if (grant.revokedAt !== null) {
          throw new ConflictException('该赠送额度已撤销，不能确认赠送课');
        }
        paidDelta = ZERO;
        giftDelta = money(grant.unitPrice).negated();
        giftGrantId = grant.id;
      } else {
        // 非赠送课：按机构扣池顺序把本课金额拆到实收 / 赠送池。允许扣成负数（欠费合法）。
        const balances = await computeEnrollmentBalances(tx, [lesson.enrollmentId]);
        const balance = balances.get(lesson.enrollmentId);
        const organization = await tx.organization.findFirst({
          select: { consumptionOrder: true },
        });
        const order = organization?.consumptionOrder ?? ConsumptionOrder.GIFT_FIRST;
        const split = splitConsumption(
          order,
          enrollment.unitPrice,
          balance?.paid ?? ZERO,
          balance?.gift ?? ZERO,
        );
        paidDelta = split.paidDelta;
        giftDelta = split.giftDelta;
      }

      await tx.ledgerEntry.create({
        data: {
          enrollmentId: lesson.enrollmentId,
          kind: LedgerKind.CONSUMPTION,
          occurredAt: confirmedAt,
          paidDelta,
          giftDelta,
          lessonId: lesson.id,
          giftGrantId,
          createdById: actor.id,
        },
      });

      return tx.lesson.update({
        where: { id: lesson.id },
        data: {
          status: LessonStatus.CONFIRMED,
          confirmedAt,
          confirmedById: actor.id,
          // 快照锁的是确认时刻的 enrollment 单价；此后改价不影响本课。
          unitPriceSnapshot: money(enrollment.unitPrice),
        },
      });
    });
  }

  // ── 请假 / 取消（US-CC-02）：曾确认过就回冲 ───────────────────────────────

  markLeave(lessonId: string, actor: AuthenticatedUser) {
    return this.transition(lessonId, actor, LessonStatus.LEAVE);
  }

  cancel(lessonId: string, actor: AuthenticatedUser) {
    return this.transition(lessonId, actor, LessonStatus.CANCELLED);
  }

  private async transition(
    lessonId: string,
    actor: AuthenticatedUser,
    target: TerminalStatus,
  ) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw new NotFoundException('排课不存在');
    await this.assertTeacherOwnsLesson(actor, lesson);

    if (lesson.status === LessonStatus.CANCELLED || lesson.status === LessonStatus.LEAVE) {
      throw new ConflictException('该课已经取消 / 请假了');
    }

    // 从未确认：只改状态，不产生任何流水。
    if (lesson.status === LessonStatus.SCHEDULED) {
      return this.prisma.lesson.update({ where: { id: lessonId }, data: { status: target } });
    }

    // 曾确认过：追加一条反向流水。回冲归属**当前时间**，该月不能已关账。
    const occurredAt = new Date();
    await this.periods.assertOpenForDate(occurredAt);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const original = await tx.ledgerEntry.findFirst({
          where: { lessonId, kind: LedgerKind.CONSUMPTION },
          orderBy: { createdAt: 'asc' },
        });
        if (!original) {
          throw new ConflictException('该课状态为已确认，但找不到对应的消费流水，无法回冲');
        }

        const alreadyReversed = await tx.ledgerEntry.findFirst({
          where: { reversesEntryId: original.id },
        });
        if (alreadyReversed) {
          throw new ConflictException('该笔消费已经被回冲过，不能重复回冲');
        }

        await tx.ledgerEntry.create({
          data: {
            enrollmentId: original.enrollmentId,
            kind: LedgerKind.CONSUMPTION_REVERSAL,
            occurredAt,
            paidDelta: money(original.paidDelta).negated(),
            giftDelta: money(original.giftDelta).negated(),
            lessonId,
            giftGrantId: original.giftGrantId,
            reversesEntryId: original.id,
            createdById: actor.id,
          },
        });

        return tx.lesson.update({ where: { id: lessonId }, data: { status: target } });
      });
    } catch (error) {
      // reversesEntryId 唯一约束兜底并发下的重复回冲，转成可读 409。
      if (isUniqueViolation(error)) {
        throw new ConflictException('该笔消费已经被回冲过，不能重复回冲');
      }
      throw error;
    }
  }

  // ── 内部断言 ──────────────────────────────────────────────────────────────

  /** 取当前登录账号关联的老师 id。 */
  private async getActorTeacherId(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { teacherId: true },
    });
    return user?.teacherId ?? null;
  }

  /**
   * 行级权限：授课老师只能操作自己名下的课。**在 service 里判**，不能只靠路由。
   * 店主不受限。
   */
  private async assertTeacherOwnsLesson(
    actor: AuthenticatedUser,
    lesson: { teacherId: string },
  ): Promise<void> {
    if (actor.role !== UserRole.TEACHER) return;
    const ownTeacherId = await this.getActorTeacherId(actor.id);
    if (!ownTeacherId || ownTeacherId !== lesson.teacherId) {
      throw new ForbiddenException('只能操作自己名下的课');
    }
  }

  /**
   * 老师时间冲突检测：同一小时区间内已有 SCHEDULED / CONFIRMED 的课即冲突。
   * 「同一小时」= 排课时间取整到小时相同；用 [hourStart, hourStart+1h) 表达。
   */
  private async assertNoTeacherConflict(
    teacherId: string,
    when: Date,
    excludeLessonId?: string,
  ): Promise<void> {
    const hourStart = new Date(when);
    hourStart.setUTCMinutes(0, 0, 0);
    const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);

    const conflict = await this.prisma.lesson.findFirst({
      where: {
        teacherId,
        status: { in: [LessonStatus.SCHEDULED, LessonStatus.CONFIRMED] },
        scheduledAt: { gte: hourStart, lt: hourEnd },
        ...(excludeLessonId ? { id: { not: excludeLessonId } } : {}),
      },
    });
    if (conflict) {
      throw new ConflictException(
        `该老师在 ${hourStart.toISOString()} 这个时段（同一小时）已有排课，时间冲突`,
      );
    }
  }

  /**
   * 赠送额度可用性：必须存在、未撤销、属于本报名关系、且还有剩余额度。
   * 剩余 = GiftGrant.lessons − 该 grant 下 status = CONFIRMED 的 Lesson 条数（用算的，不存字段）。
   */
  private async assertGiftGrantUsable(
    grantId: string | null | undefined,
    enrollmentId: string,
  ): Promise<void> {
    if (!grantId) {
      throw new BadRequestException('赠送课必须指定赠送额度 giftGrantId');
    }

    const grant = await this.prisma.giftGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw new BadRequestException('指定的赠送额度不存在');
    if (grant.enrollmentId !== enrollmentId) {
      throw new BadRequestException('该赠送额度不属于这条报名关系，不能用于本课');
    }
    if (grant.revokedAt !== null) {
      throw new ConflictException('该赠送额度已撤销，不能再用于排赠送课');
    }

    const used = await this.prisma.lesson.count({
      where: { giftGrantId: grantId, status: LessonStatus.CONFIRMED },
    });
    if (grant.lessons - used <= 0) {
      throw new ConflictException('该赠送额度已用满，不能再排赠送课');
    }
  }
}
