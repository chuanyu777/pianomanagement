import { IsBoolean, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * 修改排课（US-SC-02）。
 *
 * 只允许改时间 / 课程 / 是否赠送 / 备注。已确认的课不允许改前三者 ——
 * 要改必须先取消（走回冲），否则历史账会对不上（由 service 判，见 lessons.service.ts）。
 */
export class UpdateLessonDto {
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsUUID()
  courseTypeId?: string;

  @IsOptional()
  @IsBoolean()
  isGift?: boolean;

  @IsOptional()
  @IsUUID()
  giftGrantId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;
}
