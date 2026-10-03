import { IsOptional, Matches } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

/** 其它支出列表：分页 + 可选按归属月份过滤。 */
export class ListOtherExpensesQueryDto extends PaginationDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period?: string;
}
