import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * 手工补录一笔收入（US-IE-01 的「支持手工补录项」）。
 * incomeItemId 必须指向人工项（autoSource 为空），自动项由报表汇总 —— 由 service 判。
 */
export class CreateManualIncomeDto {
  @IsUUID()
  incomeItemId!: string;

  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;
}
