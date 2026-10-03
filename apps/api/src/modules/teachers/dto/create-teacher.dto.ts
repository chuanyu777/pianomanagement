import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TeacherStatus } from '../../../prisma/generated.js';

/**
 * 老师档案（US-BD-03）。
 *
 * 岗位 position 是**自由文本**，不做枚举限制 —— 业务上只有授课老师一种岗位，
 * 不存在的岗位不该被代码「发明」出来。
 */
export class CreateTeacherDto {
  @IsString()
  @MinLength(1, { message: '老师姓名不能为空' })
  @MaxLength(32, { message: '老师姓名最长 32 位' })
  name!: string;

  /** 岗位，可为空。允许传 null 表示清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  position?: string | null;

  /** 入职时间，ISO 字符串。允许传 null 表示清空。 */
  @IsOptional()
  @IsDateString()
  hiredAt?: string | null;

  @IsOptional()
  @IsEnum(TeacherStatus, { message: 'status 只能是 ACTIVE 或 INACTIVE' })
  status?: TeacherStatus;

  /** 课消奖比例 0~1（0.15 = 15%），为空则取机构默认。 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  commissionRate?: number | null;

  /** 基本工资默认值，为空则不预设。 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultBaseSalary?: number | null;
}
