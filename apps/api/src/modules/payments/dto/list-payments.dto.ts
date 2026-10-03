import { IsOptional, IsUUID, Matches } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

/** 交费列表查询：分页 + 可选按报名关系 / 学生 / 月份过滤。 */
export class ListPaymentsQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  enrollmentId?: string;

  @IsOptional()
  @IsUUID()
  studentId?: string;

  /** 归属月份 YYYY-MM。按 occurredAt 落在该月（UTC+8）过滤。 */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period?: string;
}
