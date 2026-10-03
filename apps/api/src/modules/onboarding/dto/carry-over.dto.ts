import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** 每位学生某课程的起始实收 / 赠送余额与自定义单价（US-IW-02）。 */
export class CarryOverEnrollmentDto {
  @IsString()
  @IsNotEmpty()
  enrollmentId!: string;

  @IsNumber()
  @Min(0)
  initialPaidBalance!: number;

  @IsNumber()
  @Min(0)
  initialGiftBalance!: number;

  @IsNumber()
  @Min(0)
  unitPrice!: number;
}

export class CarryOverStudentDto {
  @IsString()
  @IsNotEmpty()
  studentId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CarryOverEnrollmentDto)
  enrollments!: CarryOverEnrollmentDto[];
}

/**
 * 首月接续数据（US-IW-02）。
 *
 * 三个机构级字段**都是可选**：向导允许分步提交，缺哪个下次补哪个；
 * 是否「已录入」由 service 用「本次会话是否提交过」判定（0 也算录入过，见 onboarding.service）。
 * 提交不完整不会当场报错，但 `POST /onboarding/complete` 会拒绝并提示「首月报表将不正确」。
 */
export class CarryOverDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  initialCashBalance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  previousMonthProfit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  previousMonthPayroll?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CarryOverStudentDto)
  students?: CarryOverStudentDto[];
}
