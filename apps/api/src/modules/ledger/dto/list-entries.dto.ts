import { IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';
import { LedgerKind } from '../../../prisma/generated.js';

/**
 * 台账流水查询（US-ML-01）。分页 + 可选按学生 / 报名关系 / 类型 / 月份过滤。
 *
 * 学生维度不在 `LedgerEntry` 上，走报名关系（`enrollment.studentId`）过滤 ——
 * 不给流水表臆造 studentId 字段。
 */
export class ListEntriesQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @IsOptional()
  @IsUUID()
  enrollmentId?: string;

  @IsOptional()
  @IsEnum(LedgerKind, {
    message: 'kind 只能是 PAYMENT / GIFT / GIFT_REVOKE / CONSUMPTION / CONSUMPTION_REVERSAL / REFUND',
  })
  kind?: LedgerKind;

  /** 归属月份 YYYY-MM，按 occurredAt 落在该月（UTC+8）过滤。 */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 应形如 2026-10' })
  period?: string;
}
