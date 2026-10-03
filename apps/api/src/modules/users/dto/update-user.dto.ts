import { PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto.js';

/**
 * 更新用的 DTO：继承 CreateUserDto 的**全部字段与校验规则**，只是都变成可选。
 *
 * 用 PartialType 而不是手抄一遍字段 —— 手抄就会出现
 * 「改了创建时的规则、忘了同步更新时的规则」这种查不出来的偏差。
 */
export class UpdateUserDto extends PartialType(CreateUserDto) {}
