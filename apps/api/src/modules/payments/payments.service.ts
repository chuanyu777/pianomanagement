import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { money, ZERO } from '../../common/money.js';
import { periodRange } from '../../common/period.js';
import { LedgerKind, Prisma } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PeriodsService } from '../periods/periods.service.js';
import { CreatePaymentDto } from './dto/create-payment.dto.js';
import { ListPaymentsQueryDto } from './dto/list-payments.dto.js';

/**
 * 交费记账（US-ML-02）。
 *
 * 一笔交费 = 一条 `LedgerEntry{ kind: PAYMENT, paidDelta: +amount, giftDelta: 0 }`。
 * **金额进实收池，不动赠送池** —— 赠送池只由 gifts 模块的 GIFT / GIFT_REVOKE 变动。
 * 这里不写「当前余额」字段（余额只算不算，见 modules/ledger/balance.ts）。
 *
 * 只做三件事，全是别的模块不会替你兜底的不变量：
 * 1. 金额必须 > 0（否则一条负交费会把实收池凭空做少，还看不出来）。
 * 2. 收入项必须是可手工记账的人工项：自动取数项（autoSource 非空）由报表自动汇总，
 *    手工再记一笔就是重复计数。
 * 3. 归属月份（occurredAt）未关账。
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
  ) {}

  async create(dto: CreatePaymentDto, actor: AuthenticatedUser) {
    const amount = money(dto.amount);
    if (amount.lessThanOrEqualTo(ZERO)) {
      throw new BadRequestException('交费金额必须大于 0');
    }

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: dto.enrollmentId },
    });
    if (!enrollment) throw new BadRequestException('报名关系不存在，无法记账');

    const incomeItem = await this.prisma.incomeItem.findUnique({
      where: { id: dto.incomeItemId },
    });
    if (!incomeItem) throw new BadRequestException('收入项不存在');
    if (!incomeItem.isActive) throw new BadRequestException('该收入项已停用，不能用于记账');
    if (incomeItem.autoSource !== null) {
      throw new BadRequestException('该收入项是自动取数项，由报表自动汇总，不能手工记账');
    }

    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();

    return this.prisma.$transaction(async (tx) => {
      // 关账校验与写入同一个事务：否则校验通过、写入前刚好关账就会漏网。
      await this.periods.assertOpenForDate(occurredAt, tx);
      return tx.ledgerEntry.create({
        data: {
          enrollmentId: enrollment.id,
          kind: LedgerKind.PAYMENT,
          occurredAt,
          paidDelta: amount,
          giftDelta: ZERO,
          incomeItemId: incomeItem.id,
          note: dto.note ?? null,
          createdById: actor.id,
        },
      });
    });
  }

  /** 交费流水列表：按报名关系 / 学生 / 月份筛选 + 分页。 */
  async list(query: ListPaymentsQueryDto) {
    const where: Prisma.LedgerEntryWhereInput = { kind: LedgerKind.PAYMENT };
    if (query.enrollmentId !== undefined) where.enrollmentId = query.enrollmentId;
    // 学生维度不在 ledger 上，走报名关系 —— 不给 ledger 臆造 studentId 字段。
    if (query.studentId !== undefined) where.enrollment = { studentId: query.studentId };
    if (query.period !== undefined) {
      const { start, end } = periodRange(query.period);
      where.occurredAt = { gte: start, lt: end };
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}
