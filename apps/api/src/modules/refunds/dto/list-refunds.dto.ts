import { IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

/** 退费记录查询（US-RF-02）：分页 + 可选按学生过滤。 */
export class ListRefundsQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  studentId?: string;
}
