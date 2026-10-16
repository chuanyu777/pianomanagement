import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { UserRole } from '../src/generated/prisma/client.js';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard.js';
import { REQUIRED_ROLES } from '../src/modules/auth/roles.decorator.js';
import { RolesGuard } from '../src/modules/auth/roles.guard.js';
import { StudentsController } from '../src/modules/students/students.controller.js';
import { describe, expect, it, vi } from 'vitest';

describe('StudentsController', () => {
  it('protects the controller with both public guards and OWNER role', () => {
    expect(Reflect.getMetadata('__guards__', StudentsController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLES, StudentsController)).toEqual([UserRole.OWNER]);
  });

  it('rejects unknown fields and invalid names before calling the service', async () => {
    const create = vi.fn();
    const update = vi.fn();
    const controller = new StudentsController({ create, update } as never);

    expect(() => controller.create({ name: '林同学', withdrawnAt: null })).toThrow(BadRequestException);
    expect(() => controller.create({ name: '   ' })).toThrow(BadRequestException);
    expect(() => controller.update('student-1', { notes: '' })).toThrow(BadRequestException);
    expect(() => controller.update('student-1', { notes: 'x'.repeat(2001) })).toThrow(BadRequestException);
    expect(() => controller.update('student-1', { name: '林同学', unexpected: true })).toThrow(
      BadRequestException,
    );
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('trims names and accepts null notes to clear them', async () => {
    const create = vi.fn(async (input) => input);
    const update = vi.fn(async (_id, input) => input);
    const controller = new StudentsController({ create, update } as never);

    await controller.create({ name: '  林同学  ', notes: '试听后报名' });
    await controller.update('student-1', { name: ' 林同学2 ', notes: null });

    expect(create).toHaveBeenCalledWith({ name: '林同学', notes: '试听后报名' });
    expect(update).toHaveBeenCalledWith('student-1', { name: '林同学2', notes: null });
  });
});
