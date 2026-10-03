import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/** 新建工资代扣项（US-BD-08）。代扣项没有 autoSource —— 它只作为工资表的可配置列。 */
export class CreateDeductionItemDto {
  @IsString()
  @MinLength(1, { message: '代扣项名称不能为空' })
  @MaxLength(32, { message: '代扣项名称最长 32 位' })
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
