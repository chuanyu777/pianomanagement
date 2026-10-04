/**
 * 月份工具（前端版）。
 * 口径与后端 src/common/period.ts 一致：业务月份按 UTC+8 划分。
 * 这里**故意**不复刻后端的全部函数 —— 前端只做「选月份、展示月份」，
 * 任何涉及金额/月份的**计算**都以后端返回为准，前端不做业务算术（AGENTS.md R4）。
 */

export type Period = string;

/** 把一个时刻按 UTC+8 归到业务月份。 */
export function toPeriod(date: Date): Period {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function currentPeriod(now: Date = new Date()): Period {
  return toPeriod(now);
}
