import { PartialType } from '@nestjs/mapped-types';
import { CreateCourseTypeDto } from './create-course-type.dto.js';

/**
 * 更新用的 DTO：继承创建时的全部字段与校验规则，只是都变成可选。
 * 手抄一遍字段会出现「改了创建规则、忘了同步更新规则」的偏差。
 */
export class UpdateCourseTypeDto extends PartialType(CreateCourseTypeDto) {}
