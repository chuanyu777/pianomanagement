import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '../../prisma/generated.js';

/**
 * 过了 JwtAuthGuard 之后挂在 request 上的当前登录用户。
 * 这里**只放身份信息**，不放数据库实体 —— 业务要的其它字段由 service 自己查，
 * 免得出现「request 里的字段是登录那一刻的旧值」这种难查的 bug。
 */
export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
