import { IsOptional, Matches } from 'class-validator';

/** 总览查询月份；缺省由 controller 取 `currentPeriod()`。格式同 `src/common/period.ts`。 */
export class OverviewQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period?: string;
}
