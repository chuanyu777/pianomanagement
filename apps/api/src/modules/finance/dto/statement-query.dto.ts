import { Matches } from 'class-validator';

/** 收支表 / 小计的查询月份。 */
export class StatementQueryDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period!: string;
}
