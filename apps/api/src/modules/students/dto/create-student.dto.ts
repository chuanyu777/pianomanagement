import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { StudentStatus } from '../../../prisma/generated.js';

/**
 * 学生档案（US-BD-04）。
 * gradeLevel 是 1~10 的整数，仅作教学分级参考，**不参与任何定价**。
 */
export class CreateStudentDto {
  @IsString()
  @MinLength(1, { message: '学生姓名不能为空' })
  @MaxLength(32, { message: '学生姓名最长 32 位' })
  name!: string;

  @IsInt({ message: '学习级别必须是整数' })
  @Min(1, { message: '学习级别最小是 1' })
  @Max(10, { message: '学习级别最大是 10' })
  gradeLevel!: number;

  @IsOptional()
  @IsEnum(StudentStatus, { message: 'status 只能是 ENROLLED / PAUSED / WITHDRAWN' })
  status?: StudentStatus;

  @IsOptional()
  @IsBoolean()
  wantsRefund?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}
