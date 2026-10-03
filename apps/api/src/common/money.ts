import { Prisma } from '../prisma/generated.js';

/**
 * 金额工具。**全系统的金额运算都必须走这里。**
 *
 * 为什么不能用 JS `number`：0.1 + 0.2 !== 0.3。琴行系统里到处都是
 * 金额拆分（消费按比例分到实收池/赠送池、退费按费率扣手续费），
 * 用 float 会累积出「差几分钱」且对不上账的错，而且查不出来。
 * 一律用 Decimal；对外序列化成字符串，避免前端再退化成 float。
 */

export type Money = Prisma.Decimal;

export const ZERO = new Prisma.Decimal(0);

export function money(value: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

export function sumMoney(
  values: readonly (Prisma.Decimal | string | number | null | undefined)[],
): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, item) => acc.plus(money(item)), ZERO);
}

/** 金额 × 系数（比例），结果保留 2 位并四舍五入到分。 */
export function multiplyMoney(
  amount: Prisma.Decimal | string | number,
  factor: Prisma.Decimal | string | number,
): Prisma.Decimal {
  return money(amount).times(money(factor)).toDecimalPlaces(2);
}

export function isNegative(amount: Prisma.Decimal | string | number): boolean {
  return money(amount).isNegative();
}

export function isZero(amount: Prisma.Decimal | string | number): boolean {
  return money(amount).isZero();
}

export function negate(amount: Prisma.Decimal | string | number): Prisma.Decimal {
  return money(amount).negated();
}

/** 对外序列化：固定两位小数的字符串。**不要返回 Decimal 对象给前端**，让它自己处理。 */
export function toMoneyString(amount: Prisma.Decimal | string | number): string {
  return money(amount).toFixed(2);
}

/** 比较两个金额是否相等（到分）。 */
export function moneyEquals(
  a: Prisma.Decimal | string | number,
  b: Prisma.Decimal | string | number,
): boolean {
  return money(a).toDecimalPlaces(2).equals(money(b).toDecimalPlaces(2));
}

/** 比例合计是否恰好为 1（到 4 位小数）。利润分配比例校验用它。 */
export function ratiosSumToOne(ratios: readonly (Prisma.Decimal | string | number)[]): boolean {
  return sumMoney(ratios).toDecimalPlaces(4).equals(new Prisma.Decimal(1));
}
