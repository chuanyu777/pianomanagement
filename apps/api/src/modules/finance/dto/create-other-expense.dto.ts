import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 记一笔其它支出（US-IE-03）。
 *
 * 金额 > 0 是业务规则，由 service 判；这里只约束传输格式。
 * period 决定它归到哪个月（收支表按 period 汇总），occurredAt 不传则取当前时间。
 */
export class CreateOtherExpenseDto {
  @IsUUID()
  expenseItemId!: string;

  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period!: string;

  @IsString()
  @MinLength(1, { message: '摘要不能为空' })
  @MaxLength(200, { message: '摘要最长 200 位' })
  summary!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  cashAmount!: number;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}
