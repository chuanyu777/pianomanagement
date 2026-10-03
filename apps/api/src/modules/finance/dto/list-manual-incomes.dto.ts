import { IsOptional, IsUUID, Matches } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

/** 手工补录收入列表：分页 + 可选按归属月份 / 收入项过滤。 */
export class ListManualIncomesQueryDto extends PaginationDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period?: string;

  @IsOptional()
  @IsUUID()
  incomeItemId?: string;
}
