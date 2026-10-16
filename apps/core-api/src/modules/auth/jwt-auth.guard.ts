import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import type { AuthenticatedActor } from './auth.types.js';

export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  actor?: AuthenticatedActor;
};

function authorizationHeader(request: AuthenticatedRequest): string | undefined {
  const entry = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'authorization');
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = authorizationHeader(request);
    const match = authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match?.[1]) throw new UnauthorizedException('登录状态无效或已过期');
    request.actor = await this.auth.resolveActor(match[1]);
    return true;
  }
}
