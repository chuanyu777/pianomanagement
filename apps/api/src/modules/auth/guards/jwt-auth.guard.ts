import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * 「必须登录」守卫。缺 token、token 过期、用户已停用，都会在这里被拦下。
 * 它**不管角色** —— 角色由 RolesGuard 管。两个一起挂才完整。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
