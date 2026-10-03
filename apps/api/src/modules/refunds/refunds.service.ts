import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import {
  money,
  multiplyMoney,
  negate,
  sumMoney,
  toMoneyString,
  ZERO,
  type Money,
} from '../../common/money.js';
import {
  LedgerKind,
  LessonStatus,
  Prisma,
  RefundMode,
  StudentStatus,
  type RefundRecord,
} from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { computeEnrollmentBalances } from '../ledger/balance.js';
import { OrganizationService } from '../organization/organization.service.js';
import { PeriodsService } from '../periods/periods.service.js';
import { CreateRefundDto } from './dto/create-refund.dto.js';
import { ListRefundsQueryDto } from './dto/list-refunds.dto.js';

/** 手续费率的上界。比例用 1 表示 100%。 */
const MAX_FEE_RATE = money(1);

export type PendingLossStudent = {
  student: {
    id: string;
    name: string;
    status: StudentStatus;
    wantsRefund: boolean;
  };
  paidBalance: string;
  giftBalance: string;
  totalBalance: string;
};

export type SerializedRefundRecord = {
  id: string;
  studentId: string;
  mode: RefundMode;
  occurredAt: string;
  paidTotal: string;
  giftTotal: string;
  feeRate: string;
  feeAmount: string;
  refundAmount: string;
  createdById: string | null;
  createdAt: string;
};

/**
 * 退费（US-RF-01 / US-RF-02 / US-RF-03）。
 *
 * 核心口径（实施计划 §4，照抄）：
 * ```
 * paidTotal    = Σ 该学生各 Enrollment 的实收余额
 * giftTotal    = Σ 该学生各 Enrollment 的赠送余额
 * feeAmount    = paidTotal × feeRate        // 逐笔可覆盖，默认取机构设置
 * refundAmount = paidTotal − feeAmount
 * ```
 *
 * - `mode = REFUND`：每条 Enrollment 写一条 `REFUND` 流水，两池清零；状态 → WITHDRAWN。
 *   同时把该学生**未用完**的 GiftGrant 打上 `revokedAt`（与赠送池清零保持一致）；
 *   已确认过的赠送课不动。
 * - `mode = KEEP`：**不写任何流水**，余额原样保留；状态 → PAUSED；手续费与实退都记 0。
 * - 两种模式都在**同一事务**里写一条 RefundRecord。
 *
 * 余额一律走 `computeEnrollmentBalances`（`../ledger/balance.js`），不自己 SUM。
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
    private readonly organization: OrganizationService,
  ) {}

  /** US-RF-01 待处理流失学生：WITHDRAWN 或 wantsRefund，附各课程合计的实收 / 赠送池。 */
  async listPendingLosses(): Promise<PendingLossStudent[]> {
    const students = await this.prisma.student.findMany({
      where: {
        OR: [{ status: StudentStatus.WITHDRAWN }, { wantsRefund: true }],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, status: true, wantsRefund: true },
    });
    if (students.length === 0) return [];

    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId: { in: students.map((student) => student.id) } },
      select: { id: true, studentId: true },
    });

    const balances = await computeEnrollmentBalances(
      this.prisma,
      enrollments.map((enrollment) => enrollment.id),
    );

    const paidByStudent = new Map<string, Money>();
    const giftByStudent = new Map<string, Money>();
    for (const enrollment of enrollments) {
      const balance = balances.get(enrollment.id);
      if (!balance) continue;
      paidByStudent.set(
        enrollment.studentId,
        (paidByStudent.get(enrollment.studentId) ?? ZERO).plus(balance.paid),
      );
      giftByStudent.set(
        enrollment.studentId,
        (giftByStudent.get(enrollment.studentId) ?? ZERO).plus(balance.gift),
      );
    }

    return students.map((student) => {
      const paid = paidByStudent.get(student.id) ?? ZERO;
      const gift = giftByStudent.get(student.id) ?? ZERO;
      return {
        student,
        paidBalance: toMoneyString(paid),
        giftBalance: toMoneyString(gift),
        totalBalance: toMoneyString(paid.plus(gift)),
      };
    });
  }

  /** US-RF-02 / US-RF-03 退费或保留余额。 */
  async create(dto: CreateRefundDto, actor: AuthenticatedUser): Promise<SerializedRefundRecord> {
    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
      select: { id: true, status: true },
    });
    if (!student) throw new NotFoundException('学生不存在');
    if (student.status === StudentStatus.WITHDRAWN) {
      throw new ConflictException('该学生已退学（WITHDRAWN），不能再次处理退费');
    }

    // 逐笔费率优先，否则取机构默认。到分。
    const feeRate =
      dto.feeRate !== undefined
        ? money(dto.feeRate)
        : money((await this.organization.get()).refundFeeRate);
    if (feeRate.lessThan(ZERO) || feeRate.greaterThan(MAX_FEE_RATE)) {
      throw new BadRequestException('退费手续费率必须在 0~1 之间');
    }

    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    const mode = dto.mode;

    return this.prisma.$transaction(async (tx) => {
      // 关账校验与写入同一事务：否则校验通过、写入前刚好关账就会漏网。
      await this.periods.assertOpenForDate(occurredAt, tx);

      const enrollments = await tx.enrollment.findMany({
        where: { studentId: student.id },
        select: { id: true },
      });
      const enrollmentIds = enrollments.map((enrollment) => enrollment.id);
      const balances = await computeEnrollmentBalances(tx, enrollmentIds);

      const paidTotal = sumMoney(
        enrollmentIds.map((id) => balances.get(id)?.paid ?? ZERO),
      );
      const giftTotal = sumMoney(
        enrollmentIds.map((id) => balances.get(id)?.gift ?? ZERO),
      );
      // KEEP 不真退钱，就没有手续费与实退金额。
      const isRefund = mode === RefundMode.REFUND;
      const feeAmount = isRefund ? multiplyMoney(paidTotal, feeRate) : ZERO;
      const refundAmount = isRefund ? paidTotal.minus(feeAmount) : ZERO;

      const record = await tx.refundRecord.create({
        data: {
          studentId: student.id,
          mode,
          occurredAt,
          paidTotal,
          giftTotal,
          feeRate,
          feeAmount,
          refundAmount,
          createdById: actor.id,
        },
      });

      if (isRefund) {
        // 每条报名写一条 REFUND，实收 / 赠送两池清零（取该条余额的相反数）。
        for (const enrollmentId of enrollmentIds) {
          const balance = balances.get(enrollmentId);
          await tx.ledgerEntry.create({
            data: {
              enrollmentId,
              kind: LedgerKind.REFUND,
              occurredAt,
              paidDelta: negate(balance?.paid ?? ZERO),
              giftDelta: negate(balance?.gift ?? ZERO),
              refundRecordId: record.id,
              note: dto.note ?? null,
              createdById: actor.id,
            },
          });
        }
        await this.revokeUnusedGrants(tx, enrollmentIds, occurredAt, actor.id);
      }

      await tx.student.update({
        where: { id: student.id },
        data: {
          status: isRefund ? StudentStatus.WITHDRAWN : StudentStatus.PAUSED,
          wantsRefund: false,
        },
      });

      return this.serialize(record);
    });
  }

  /** US-RF-03 退费记录查询。 */
  async list(query: ListRefundsQueryDto) {
    const where: Prisma.RefundRecordWhereInput = {};
    if (query.studentId !== undefined) where.studentId = query.studentId;

    const [records, total] = await this.prisma.$transaction([
      this.prisma.refundRecord.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.refundRecord.count({ where }),
    ]);

    return {
      items: records.map((record) => this.serialize(record)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * 把该学生各报名下**未用完**的赠送额度作废（与赠送池清零保持一致）。
   *
   * 「未用完」= 该 grant 下已确认的赠送课条数 < 发放节数，用算的、不存字段。
   * 已经用满的额度不动，已经确认过的赠送课也一行不改 —— 只标 revokedAt 阻止后续再消耗。
   * 赠送池的金额清零由 REFUND 流水的 giftDelta 承担，这里**不再写 GIFT_REVOKE 流水**，
   * 否则会双重冲减。
   */
  private async revokeUnusedGrants(
    tx: Pick<PrismaService, 'giftGrant' | 'lesson'>,
    enrollmentIds: readonly string[],
    occurredAt: Date,
    actorId: string,
  ): Promise<void> {
    if (enrollmentIds.length === 0) return;

    const grants = await tx.giftGrant.findMany({
      where: { enrollmentId: { in: [...enrollmentIds] }, revokedAt: null },
      select: { id: true, lessons: true },
    });
    if (grants.length === 0) return;

    const confirmedRows = await tx.lesson.groupBy({
      by: ['giftGrantId'],
      where: {
        giftGrantId: { in: grants.map((grant) => grant.id) },
        status: LessonStatus.CONFIRMED,
      },
      _count: { _all: true },
    });
    const confirmedByGrant = new Map<string, number>();
    for (const row of confirmedRows) {
      if (row.giftGrantId !== null) confirmedByGrant.set(row.giftGrantId, row._count._all);
    }

    const unusedIds = grants
      .filter((grant) => (confirmedByGrant.get(grant.id) ?? 0) < grant.lessons)
      .map((grant) => grant.id);
    if (unusedIds.length === 0) return;

    await tx.giftGrant.updateMany({
      where: { id: { in: unusedIds }, revokedAt: null },
      data: { revokedAt: occurredAt, revokedById: actorId },
    });
  }

  private serialize(record: RefundRecord): SerializedRefundRecord {
    return {
      id: record.id,
      studentId: record.studentId,
      mode: record.mode,
      occurredAt: record.occurredAt.toISOString(),
      paidTotal: toMoneyString(record.paidTotal),
      giftTotal: toMoneyString(record.giftTotal),
      feeRate: money(record.feeRate).toString(),
      feeAmount: toMoneyString(record.feeAmount),
      refundAmount: toMoneyString(record.refundAmount),
      createdById: record.createdById,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
