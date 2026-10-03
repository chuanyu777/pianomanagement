import { Matches } from 'class-validator';

/**
 * 按月查询（工资表 / 两口径 / 我的工资都复用它）。
 * 月份格式与其它模块保持一致：`YYYY-MM`，正则口径同 `src/common/period.ts`。
 */
export class PayrollPeriodQueryDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period!: string;
}
