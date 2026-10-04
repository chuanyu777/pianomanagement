import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { MAX_PASSWORD_BYTES } from '../../../common/password.js';
import { UserRole } from '../../../prisma/generated.js';

export const MIN_PASSWORD_LENGTH = 8;
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

/**
 * 密码限制为 ASCII 可见字符。
 * 目的不是「更安全」，而是让「最长 72」这个约束可判定 ——
 * bcrypt 只吃前 72 **字节**，中文一个字占 3 字节，
 * 只按字符数限制会让实际校验口径和实现口径对不上。
 */
export const PASSWORD_PATTERN = /^[\x20-\x7E]+$/;

export class CreateUserDto {
  @IsString()
  @Matches(USERNAME_PATTERN, {
    message: '用户名只能是 3-32 位小写字母、数字、点、下划线或短横线',
  })
  username!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, { message: `密码至少 ${MIN_PASSWORD_LENGTH} 位` })
  @MaxLength(MAX_PASSWORD_BYTES, { message: `密码最长 ${MAX_PASSWORD_BYTES} 位` })
  @Matches(PASSWORD_PATTERN, { message: '密码只能用 ASCII 可见字符（不要用中文、全角或控制字符）' })
  password!: string;

  @IsString()
  @MinLength(1, { message: '显示名不能为空' })
  @MaxLength(32, { message: '显示名最长 32 位' })
  displayName!: string;

  @IsEnum(UserRole, { message: 'role 只能是 OWNER（店主）或 TEACHER（授课老师）' })
  role!: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * 关联的老师档案（US-AC-01：可关联某位老师或为独立账号）。
   * 传了它，这个账号就能以「授课老师」身份看自己的课与工资。
   */
  @IsOptional()
  @IsUUID('4', { message: 'teacherId 必须是合法的 ID' })
  teacherId?: string;
}
