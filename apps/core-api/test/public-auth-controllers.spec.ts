import 'reflect-metadata';
import { UserRole } from '../src/generated/prisma/client.js';
import { AuthController } from '../src/modules/auth/auth.controller.js';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard.js';
import { REQUIRED_ROLES } from '../src/modules/auth/roles.decorator.js';
import { RolesGuard } from '../src/modules/auth/roles.guard.js';
import { TeachersController } from '../src/modules/teachers/teachers.controller.js';
import { describe, expect, it, vi } from 'vitest';

describe('public auth and teacher controllers', () => {
  it('protects current-user and teacher management endpoints with both public guards', () => {
    expect(Reflect.getMetadata('__guards__', AuthController.prototype.me)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(REQUIRED_ROLES, AuthController.prototype.me)).toEqual([
      UserRole.OWNER,
      UserRole.TEACHER,
    ]);
    expect(Reflect.getMetadata('__guards__', TeachersController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(REQUIRED_ROLES, TeachersController)).toEqual([UserRole.OWNER]);
  });

  it('does not send malformed login or teacher payloads to services', () => {
    const login = vi.fn();
    const auth = new AuthController({ login } as never);
    expect(() => auth.login({ username: 'owner', password: 1 })).toThrow('请求参数不合法');
    expect(login).not.toHaveBeenCalled();

    const create = vi.fn();
    const teachers = new TeachersController({ create } as never);
    expect(() => teachers.create({ username: 'teacher', password: 'too-short', name: '老师' })).toThrow(
      '请求参数不合法',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('exposes teacher login provisioning only behind owner JWT and role guards', () => {
    expect(Reflect.getMetadata('__guards__', TeachersController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLES, TeachersController)).toEqual([UserRole.OWNER]);
    const openLoginAccount = vi.fn();
    const teachers = new TeachersController({ openLoginAccount } as never);
    expect(() => teachers.openLoginAccount('not-a-uuid', { username: 'teacher', password: 'a-safe-password' })).toThrow('请求参数不合法');
    expect(openLoginAccount).not.toHaveBeenCalled();
  });
});
