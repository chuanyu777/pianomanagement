import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';
import { TeacherStatus } from '../../../prisma/generated.js';

/** 老师列表查询：分页 + 可选按状态过滤。 */
export class ListTeachersQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(TeacherStatus, { message: 'status 只能是 ACTIVE 或 INACTIVE' })
  status?: TeacherStatus;
}
