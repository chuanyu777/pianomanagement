import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PayrollDeductionDto } from './payroll-deduction.dto.js';

/**
 * 工资基础项录入（US-PR-06）。
 *
 * 这一层只做传输格式约束；「老师/代扣项是否存在」「月份是否关账」是业务规则，
 * 全部在 service 里判（前端判断能被绕过）。
 *
 * **每个字段都是可选的**：不传 = 保持原值。service 不会把未传字段写成 0
 * —— 否则「只改出勤」的调用会把基本工资清零。
 */
export class UpsertPayrollDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period!: string;

  @IsOptional()
  @IsInt({ message: '应到天数必须是整数' })
  @Min(0, { message: '应到天数不能为负' })
  attendanceExpected?: number;

  @IsOptional()
  @IsInt({ message: '实到天数必须是整数' })
  @Min(0, { message: '实到天数不能为负' })
  attendanceActual?: number;

  @IsOptional()
  @IsInt({ message: '缺勤天数必须是整数' })
  @Min(0, { message: '缺勤天数不能为负' })
  attendanceAbsent?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseSalary?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  pianoBonus?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  recruitBonus?: number;

  /** 课消奖比例 0~1（0.15 = 15%），逐月覆盖；不传则沿用老师档案 / 机构默认。 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  commissionRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;

  /** 代扣项明细。传了（含空数组）就整体替换；不传则保持原样。 */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PayrollDeductionDto)
  deductions?: PayrollDeductionDto[];
}
