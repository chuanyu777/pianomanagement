import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { money, multiplyMoney, negate, toMoneyString, ZERO } from '../../common/money.js';
import { periodRange } from '../../common/period.js';
import { LedgerKind, LessonStatus, Prisma } from '../../prisma/generated.js';
import type { GiftGrant } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PeriodsService } from '../periods/periods.service.js';
import { CreateGiftDto } from './dto/create-gift.dto.js';
import { ListGiftsQueryDto } from './dto/list-gifts.dto.js';

/** 赠送记录 + 剩余额度（用算的，不落字段）。 */
export type GiftGrantWithRemaining = GiftGrant & { remaining: number };

/** US-GL-02：某次活动一共送了多少。 */
export type ActivityGiftSummary = {
  activityName: string;
  totalLessons: number;
  totalAmount: string;
  grantCount: number;
};

/**
 * 赠送（US-GL-01 / US-GL-02 / US-GL-03）。
 *
 * 三条口径写死在这里：
 * 1. 折算单价取**该报名关系的实际单价**（或显式覆盖），`amount = lessons × unitPrice`；
 *    金额只进赠送池（`giftDelta`），实收池不动。
 * 2. **赠课成本是赠送当月一次性计入经营支出**，不按上课月摊销 —— 报表模块从这条
 *    `GIFT` 流水按 `occurredAt` 所在月汇总即可，这里不另建成本表。
 * 3. 额度占用 = 该 grant 下 `status = CONFIRMED` 的 Lesson 条数，
 *    `remaining = lessons − 已确认条数`，**用算的，不存字段**（存一份就会和上课确认对不上）。
 *
 * 不 import lessons 模块的任何东西（避免循环依赖）；剩余额度直接用 `prisma.lesson.count` 算。
 */
@Injectable()
export class GiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
  ) {}

  async createGift(dto: CreateGiftDto, actor: AuthenticatedUser): Promise<GiftGrant> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: dto.enrollmentId },
    });
    if (!enrollment) throw new NotFoundException('报名关系不存在，无法赠送');

    // 折算单价：显式覆盖优先，否则取该学生此课程的实际单价。
    const unitPrice =
      dto.unitPrice !== undefined ? money(dto.unitPrice) : money(enrollment.unitPrice);
    if (unitPrice.lessThanOrEqualTo(ZERO)) {
      throw new BadRequestException('折算单价必须大于 0');
    }
    const amount = multiplyMoney(dto.lessons, unitPrice);
    const grantedAt = dto.grantedAt ? new Date(dto.grantedAt) : new Date();

    return this.prisma.$transaction(async (tx) => {
      // 赠课成本归属 grantedAt 所在月，该月已关账就不能再建。
      await this.periods.assertOpenForDate(grantedAt, tx);

      const grant = await tx.giftGrant.create({
        data: {
          enrollmentId: enrollment.id,
          lessons: dto.lessons,
          unitPrice,
          amount,
          activityName: dto.activityName,
          grantedAt,
          grantedById: actor.id,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          enrollmentId: enrollment.id,
          kind: LedgerKind.GIFT,
          occurredAt: grantedAt,
          paidDelta: ZERO,
          giftDelta: amount,
          giftGrantId: grant.id,
          createdById: actor.id,
        },
      });

      return grant;
    });
  }

  async revokeGift(grantId: string, actor: AuthenticatedUser): Promise<GiftGrant> {
    const grant = await this.prisma.giftGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw new NotFoundException('赠送记录不存在');
    if (grant.revokedAt !== null) throw new ConflictException('该赠送已撤销，不能重复撤销');

    // 已经上过的赠送课若被撤销，成本会被凭空冲掉而课时仍然消耗 —— 直接拒绝。
    const confirmedLessons = await this.prisma.lesson.count({
      where: { giftGrantId: grant.id, status: LessonStatus.CONFIRMED },
    });
    if (confirmedLessons > 0) {
      throw new ConflictException(
        `该赠送已有 ${confirmedLessons} 节已确认的赠送课，撤销会把已消耗的成本凭空冲掉，不能撤销`,
      );
    }

    const occurredAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      await this.periods.assertOpenForDate(occurredAt, tx);

      await tx.ledgerEntry.create({
        data: {
          enrollmentId: grant.enrollmentId,
          kind: LedgerKind.GIFT_REVOKE,
          occurredAt,
          paidDelta: ZERO,
          giftDelta: negate(grant.amount),
          giftGrantId: grant.id,
          createdById: actor.id,
        },
      });

      // 条件更新（revokedAt = null）是并发下「同一笔只能撤销一次」在数据库层的兜底：
      // 两个请求同时撤销，只有一个能命中，另一个 count=0 → 回滚并报 409。
      const updated = await tx.giftGrant.updateMany({
        where: { id: grant.id, revokedAt: null },
        data: { revokedAt: occurredAt, revokedById: actor.id },
      });
      if (updated.count === 0) {
        throw new ConflictException('该赠送已撤销，不能重复撤销');
      }

      return { ...grant, revokedAt: occurredAt, revokedById: actor.id };
    });
  }

  /** 赠送记录列表：按学生 / 课程 / 活动名称 / 月份过滤 + 分页，逐条附剩余额度。 */
  async listGrants(query: ListGiftsQueryDto): Promise<{
    items: GiftGrantWithRemaining[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where: Prisma.GiftGrantWhereInput = {};
    const enrollmentWhere: Prisma.EnrollmentWhereInput = {};
    if (query.studentId !== undefined) enrollmentWhere.studentId = query.studentId;
    if (query.courseTypeId !== undefined) enrollmentWhere.courseTypeId = query.courseTypeId;
    if (Object.keys(enrollmentWhere).length > 0) where.enrollment = enrollmentWhere;
    if (query.activityName !== undefined) where.activityName = query.activityName;
    if (query.period !== undefined) {
      const { start, end } = periodRange(query.period);
      where.grantedAt = { gte: start, lt: end };
    }

    const [grants, total] = await this.prisma.$transaction([
      this.prisma.giftGrant.findMany({
        where,
        orderBy: { grantedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.giftGrant.count({ where }),
    ]);

    const items = await this.attachRemaining(grants);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** US-GL-02：按活动名称汇总营销成本（只计未撤销的赠送，已撤销的已冲回成本）。 */
  async summaryByActivity(): Promise<ActivityGiftSummary[]> {
    const rows = await this.prisma.giftGrant.groupBy({
      by: ['activityName'],
      where: { revokedAt: null },
      _sum: { lessons: true, amount: true },
      _count: { _all: true },
      orderBy: { activityName: 'asc' },
    });

    return rows.map((row) => ({
      activityName: row.activityName,
      totalLessons: row._sum.lessons ?? 0,
      totalAmount: toMoneyString(row._sum.amount ?? ZERO),
      grantCount: row._count._all,
    }));
  }

  /**
   * 批量算剩余额度：一次 groupBy 取回所有已确认条数，避免逐条 count 的 N+1。
   */
  private async attachRemaining(grants: GiftGrant[]): Promise<GiftGrantWithRemaining[]> {
    const ids = grants.map((grant) => grant.id);
    if (ids.length === 0) return [];

    const usedRows = await this.prisma.lesson.groupBy({
      by: ['giftGrantId'],
      where: { giftGrantId: { in: ids }, status: LessonStatus.CONFIRMED },
      _count: { _all: true },
    });
    const usedByGrant = new Map<string, number>();
    for (const row of usedRows) {
      if (row.giftGrantId !== null) usedByGrant.set(row.giftGrantId, row._count._all);
    }

    return grants.map((grant) => ({
      ...grant,
      remaining: grant.lessons - (usedByGrant.get(grant.id) ?? 0),
    }));
  }
}
