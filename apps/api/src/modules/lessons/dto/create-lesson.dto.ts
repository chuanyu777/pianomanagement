import { IsBoolean, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * 新建排课（US-SC-01）。
 *
 * 排课必须绑定到一条 Enrollment —— 学生 + 授课老师 + 课程 三者一起才能定位报名关系，
 * 所以三个 id 都要传；service 用 enrollment_identity 复合唯一键去查，查不到就提示先报名。
 */
export class CreateLessonDto {
  @IsUUID()
  studentId!: string;

  @IsUUID()
  teacherId!: string;

  @IsUUID()
  courseTypeId!: string;

  @IsDateString()
  scheduledAt!: string;

  /** 是否赠送课。赠送课必须带 giftGrantId（由 service 判）。 */
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
