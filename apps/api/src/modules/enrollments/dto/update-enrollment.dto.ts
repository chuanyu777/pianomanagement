import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * 修改报名关系。
 *
 * 只允许改「单价 + 生效区间」这三样：
 * - 身份三元组 (student, teacher, course) 是唯一约束的键，改了等于换一条报名关系，不是改；
 * - 起始余额是接续数据，一旦有了台账流水再改就会让余额对不上账。
 *
 * 改单价**不影响历史消费** —— 历史课时价走 Lesson.unitPriceSnapshot，由排课模块锁定。
 */
export class UpdateEnrollmentDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;
}
