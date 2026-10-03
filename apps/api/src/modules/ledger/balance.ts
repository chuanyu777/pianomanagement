import { money, ZERO, type Money } from '../../common/money.js';
import { ConsumptionOrder } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * 余额计算。**这是全系统唯一的权威实现。**
 *
 * 余额不落库：`Enrollment` 只存起始值，之后所有变动都是 `LedgerEntry` 上的
 * 带符号 delta。所以这里两个查询就能算完，不需要遍历流水，也不会 N+1。
 *
 * 任何模块要余额，一律调这里；自己写 SUM 就是第二份实现，
 * 迟早会和这里算出不一样的结果，而且不会报错。
 */

/** 只要这两个 model，事务客户端也满足这个形状。 */
export type BalancePrisma = Pick<PrismaService, 'enrollment' | 'ledgerEntry'>;

export type EnrollmentBalance = {
  enrollmentId: string;
  paid: Money;
  gift: Money;
  total: Money;
};

export async function computeEnrollmentBalances(
  prisma: BalancePrisma,
  enrollmentIds: readonly string[],
): Promise<Map<string, EnrollmentBalance>> {
  const result = new Map<string, EnrollmentBalance>();
  if (enrollmentIds.length === 0) return result;

  const ids = [...enrollmentIds];
  const [enrollments, sums] = await Promise.all([
    prisma.enrollment.findMany({
      where: { id: { in: ids } },
      select: { id: true, initialPaidBalance: true, initialGiftBalance: true },
    }),
    prisma.ledgerEntry.groupBy({
      by: ['enrollmentId'],
      where: { enrollmentId: { in: ids } },
      _sum: { paidDelta: true, giftDelta: true },
    }),
  ]);

  const deltaByEnrollment = new Map<string, { paid: Money; gift: Money }>();
  for (const row of sums) {
    deltaByEnrollment.set(row.enrollmentId, {
      paid: money(row._sum.paidDelta),
      gift: money(row._sum.giftDelta),
    });
  }

  for (const enrollment of enrollments) {
    const delta = deltaByEnrollment.get(enrollment.id) ?? { paid: ZERO, gift: ZERO };
    const paid = money(enrollment.initialPaidBalance).plus(delta.paid);
    const gift = money(enrollment.initialGiftBalance).plus(delta.gift);
    result.set(enrollment.id, {
      enrollmentId: enrollment.id,
      paid,
      gift,
      total: paid.plus(gift),
    });
  }

  return result;
}

export type PoolSplit = {
  paidDelta: Money;
  giftDelta: Money;
};

/**
 * 把一笔消费按扣减顺序拆到实收池 / 赠送池。
 *
 * 两条容易写错、写错了也不会报错的点：
 * 1. **不做「扣到 0 就停」的截断**。余额允许为负 —— 负余额就是欠费，
 *    是需求明确要求的合法状态。截断会让欠费永远显示 0，催收名单直接失效。
 * 2. 某个池已经是负数时，不能拿负数当「可用额度」去抵扣，
 *    否则会把欠费越扣越少（等于凭空消账）。所以可用额度取 `max(balance, 0)`。
 */
export function splitConsumption(
  order: ConsumptionOrder,
  amount: Money | string | number,
  paidBalance: Money | string | number,
  giftBalance: Money | string | number,
): PoolSplit {
  const total = money(amount);
  const availablePaid = money(paidBalance).greaterThan(ZERO) ? money(paidBalance) : ZERO;
  const availableGift = money(giftBalance).greaterThan(ZERO) ? money(giftBalance) : ZERO;

  if (order === ConsumptionOrder.GIFT_FIRST) {
    const fromGift = total.lessThan(availableGift) ? total : availableGift;
    return { paidDelta: total.minus(fromGift).negated(), giftDelta: fromGift.negated() };
  }

  const fromPaid = total.lessThan(availablePaid) ? total : availablePaid;
  return { paidDelta: fromPaid.negated(), giftDelta: total.minus(fromPaid).negated() };
}
