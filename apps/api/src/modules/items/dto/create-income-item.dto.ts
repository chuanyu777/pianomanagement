import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AutoSource } from '../../../prisma/generated.js';

/** 新建收入项（US-BD-08）。autoSource 非空 = 自动取数项，由收支表自动汇总。 */
export class CreateIncomeItemDto {
  @IsString()
  @MinLength(1, { message: '收入项名称不能为空' })
  @MaxLength(32, { message: '收入项名称最长 32 位' })
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsEnum(AutoSource)
  autoSource?: AutoSource | null;
}
