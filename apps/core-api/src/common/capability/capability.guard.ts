import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CapabilityTokenService, type CapabilityPayload } from './capability-token.service.js';
import { CAPABILITY_PERMISSION, type CapabilityPermission } from './requires-capability.js';

export type CapabilityRequest = {
  headers: { authorization?: string };
  capability?: CapabilityPayload;
};

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: CapabilityTokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<CapabilityPermission>(CAPABILITY_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) throw new ForbiddenException('内部路由缺少 Capability 权限声明');

    const request = context.switchToHttp().getRequest<CapabilityRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('缺少 Capability');
    const payload = this.tokens.verify(header.slice('Bearer '.length));
    if (!payload.permissions.includes(permission)) throw new ForbiddenException('Capability 权限不足');
    request.capability = payload;
    return true;
  }
}
