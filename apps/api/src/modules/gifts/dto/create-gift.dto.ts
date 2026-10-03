import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 新建赠送（US-GL-01）。
 *
 * lessons 必须是 ≥1 的整数（节数）。
 * 折算单价默认取该 Enrollment 的 unitPrice（需求：取该学生此课程的实际单价），
 * 可传 unitPrice 覆盖；到 service 再转成 Decimal。
 */
export class CreateGiftDto {
  @IsUUID()
  enrollmentId!: string;

  @IsInt()
  @Min(1)
  lessons!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  activityName!: string;

  @IsOptional()
  @IsDateString()
  grantedAt?: string;

  /** 可选：覆盖该报名关系的折算单价。 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  unitPrice?: number;
}
