import { IsString, MinLength } from 'class-validator';

/**
 * 登录入参。
 *
 * **刻意**不做密码强度校验：登录只负责「对不对」，不负责「合不合规」。
 * 在登录口拦强度会让历史账号改不动密码策略时直接登不进来，
 * 同时也等于把密码策略白送给攻击者。
 */
export class LoginDto {
  @IsString()
  @MinLength(1, { message: '用户名不能为空' })
  username!: string;

  @IsString()
  @MinLength(1, { message: '密码不能为空' })
  password!: string;
}
