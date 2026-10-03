import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';
import { StudentStatus } from '../../../prisma/generated.js';

/** 学生列表查询：分页 + 可选按状态过滤（如只看在读 / 只看流失）。 */
export class ListStudentsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(StudentStatus, { message: 'status 只能是 ENROLLED / PAUSED / WITHDRAWN' })
  status?: StudentStatus;
}
