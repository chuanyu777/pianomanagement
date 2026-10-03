import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

/** 赠送记录查询：分页 + 可选按学生 / 课程 / 活动名称 / 月份过滤。 */
export class ListGiftsQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @IsOptional()
  @IsUUID()
  courseTypeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  activityName?: string;

  /** 赠送归属月份 YYYY-MM。按 grantedAt 落在该月（UTC+8）过滤。 */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period?: string;
}
