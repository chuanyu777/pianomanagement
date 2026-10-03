import { IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

/** 报名关系列表查询：分页 + 可按学生过滤（查某个学生的各条报名关系）。 */
export class ListEnrollmentsQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  studentId?: string;
}
