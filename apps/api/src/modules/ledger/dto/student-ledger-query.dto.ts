import { IsOptional, Matches } from 'class-validator';

/**
 * 学生台账查询（US-ML-01）。
 *
 * `period` 只做格式校验：**余额是当前值，不按月切分**（实施计划 §1：
 * 余额 = 起始值 + SUM(全部 delta)）。需求里「可按月份筛选」指的是交易流水，
 * 那条在 `GET /ledger/entries` 上。这里保留 period 是为了前端月份选择器能把
 * 同一组参数透传过来，不让前端为不同接口记两套参数名。
 */
export class StudentLedgerQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period?: string;
}
