import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateCourseTypeDto {
  @IsString()
  @MinLength(1, { message: '课程类型名称不能为空' })
  @MaxLength(32, { message: '课程类型名称最长 32 位' })
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
