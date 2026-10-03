import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/** 趋势默认展示近 6 个月、上限 12 个月（需求 US-AN-02）。 */
export const DEFAULT_TREND_MONTHS = 6;
export const MAX_TREND_MONTHS = 12;

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 排行 / 趋势共用的月份查询；缺省由 controller 取 `currentPeriod()`。 */
export class RankingQueryDto {
  @IsOptional()
  @Matches(PERIOD_PATTERN, { message: 'period 应形如 2026-10' })
  period?: string;
}

export class TrendQueryDto {
  @IsOptional()
  @Matches(PERIOD_PATTERN, { message: 'period 应形如 2026-10' })
  period?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TREND_MONTHS)
  months: number = DEFAULT_TREND_MONTHS;
}
