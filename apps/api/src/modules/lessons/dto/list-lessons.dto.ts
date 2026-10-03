import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

/** 排课列表：分页 + 可选按老师、按排课时间区间过滤。 */
export class ListLessonsQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  /** 区间起点（含）。 */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** 区间终点（含）。 */
  @IsOptional()
  @IsDateString()
  to?: string;
}
