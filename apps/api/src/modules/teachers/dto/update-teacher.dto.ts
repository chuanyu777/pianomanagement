import { PartialType } from '@nestjs/mapped-types';
import { CreateTeacherDto } from './create-teacher.dto.js';

/** 更新用 DTO：字段与校验规则跟创建一致，只是全部可选。停用 = 传 status=INACTIVE。 */
export class UpdateTeacherDto extends PartialType(CreateTeacherDto) {}
