import 'reflect-metadata';
import { UserRole } from '../src/generated/prisma/client.js';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard.js';
import { REQUIRED_ROLES } from '../src/modules/auth/roles.decorator.js';
import { RolesGuard } from '../src/modules/auth/roles.guard.js';
import { StudentCourseAccountsController } from '../src/modules/student-course-accounts/student-course-accounts.controller.js';
import { describe, expect, it, vi } from 'vitest';

describe('StudentCourseAccountsController', () => {
  it('keeps every account management endpoint behind owner authentication', () => {
    const controller = new StudentCourseAccountsController({
      create: vi.fn(),
      listForStudent: vi.fn(),
      updatePrice: vi.fn(),
    } as never);

    expect(controller).toBeInstanceOf(StudentCourseAccountsController);
    expect(Reflect.getMetadata('__guards__', StudentCourseAccountsController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(REQUIRED_ROLES, StudentCourseAccountsController)).toEqual([UserRole.OWNER]);
  });
});
