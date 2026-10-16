import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type UserRole } from '../../generated/prisma/client.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';
import { REQUIRED_ROLES } from './roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.actor !== undefined && roles.includes(request.actor.role);
  }
}
