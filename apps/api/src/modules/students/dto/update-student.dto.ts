import { PartialType } from '@nestjs/mapped-types';
import { CreateStudentDto } from './create-student.dto.js';

/** 更新用 DTO：字段与校验一致，全部可选。状态流转同样走这里。 */
export class UpdateStudentDto extends PartialType(CreateStudentDto) {}
