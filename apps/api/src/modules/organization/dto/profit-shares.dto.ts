import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ProfitShareItemDto {
  @IsString() @MaxLength(32) name!: string;

  @IsNumber() @Min(0) @Max(1) ratio!: number;
}

/** 整体替换利润分配规则。比例合计必须等于 1，由 service 校验。 */
export class ReplaceProfitSharesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProfitShareItemDto)
  rules!: ProfitShareItemDto[];
}
