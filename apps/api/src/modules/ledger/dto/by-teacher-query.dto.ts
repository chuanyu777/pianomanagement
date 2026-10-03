import { IsOptional, Matches } from 'class-validator';

/**
 * 按老师分组查看（US-ML-01）的查询参数。
 *
 * 与 `StudentLedgerQueryDto` 同理：余额是当前值，period 只做格式校验，
 * 不作为余额的时间切分。
 */
export class ByTeacherQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period?: string;
}
