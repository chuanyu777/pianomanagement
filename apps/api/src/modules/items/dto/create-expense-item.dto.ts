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

/** 新建支出项（US-BD-08）。autoSource 非空 = 自动取数项（工资 / 赠课成本 / 利润分配 / 退费）。 */
export class CreateExpenseItemDto {
  @IsString()
  @MinLength(1, { message: '支出项名称不能为空' })
  @MaxLength(32, { message: '支出项名称最长 32 位' })
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
