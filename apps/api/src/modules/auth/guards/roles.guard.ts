import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator.js';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator.js';
import type { UserRole } from '../../../prisma/generated.js';

/**
 * 按 @Roles(...) 的声明做角色校验。
 *
 * 默认拒绝还是默认放行？这里是**默认放行**（没标 @Roles 就不限角色）——
 * 所以「哪些接口必须登录」永远靠 JwtAuthGuard。
 * 新写接口时如果只挂了 RolesGuard 没挂 JwtAuthGuard，@Roles 就形同虚设。
 * 这条在 AGENTS.md 里是硬规则。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('未登录');
    if (!required.includes(user.role)) throw new ForbiddenException('当前角色无权访问该接口');

    return true;
  }
}
