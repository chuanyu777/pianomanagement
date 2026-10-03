import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { MAX_PASSWORD_BYTES } from '../../../common/password.js';
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_PATTERN,
  USERNAME_PATTERN,
} from '../../users/dto/create-user.dto.js';

export class CreateFirstOwnerDto {
  @IsString()
  @Matches(USERNAME_PATTERN, { message: '用户名只能是 3-32 位小写字母、数字、点、下划线或短横线' })
  username!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, { message: `密码至少 ${MIN_PASSWORD_LENGTH} 位` })
  @MaxLength(MAX_PASSWORD_BYTES, { message: `密码最长 ${MAX_PASSWORD_BYTES} 位` })
  @Matches(PASSWORD_PATTERN, { message: '密码只能用 ASCII 可见字符' })
  password!: string;

  @IsString() @MinLength(1) @MaxLength(32) displayName!: string;

  @IsOptional() @IsString() @MaxLength(64) organizationName?: string;
}
