import { IsDateString, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';

/**
 * 新建报名关系（US-BD-05）。
 *
 * 一条报名关系 = 学生 + 老师 + 课程 + 该学生此课程的**自定义单价** + 生效区间。
 * 起始实收 / 赠送余额是接续数据（US-IW-02），只在创建时录入。
 */
export class CreateEnrollmentDto {
  @IsUUID()
  studentId!: string;

  @IsUUID()
  teacherId!: string;

  @IsUUID()
  courseTypeId!: string;

  /** 该学生此课程的自定义单价。必须 > 0，否则「预计剩余课时」会除零（由 service 判）。 */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice!: number;

  @IsDateString()
  effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;

  /** 起始实收余额（接续数据）。可为负 —— 学生可能本来就有欠费。 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  initialPaidBalance?: number;

  /** 起始赠送余额（接续数据）。 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  initialGiftBalance?: number;
}
