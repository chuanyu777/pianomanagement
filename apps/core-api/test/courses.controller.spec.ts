import 'reflect-metadata';
import { Prisma, UserRole } from '../src/generated/prisma/client.js';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard.js';
import { REQUIRED_ROLES } from '../src/modules/auth/roles.decorator.js';
import { RolesGuard } from '../src/modules/auth/roles.guard.js';
import { CoursesController } from '../src/modules/courses/courses.controller.js';
import { describe, expect, it, vi } from 'vitest';

describe('CoursesController', () => {
  it('protects course management with both guards and the owner role', () => {
    expect(Reflect.getMetadata('__guards__', CoursesController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLES, CoursesController)).toEqual([UserRole.OWNER]);
  });

  it('rejects invalid strict payloads before calling the service', async () => {
    const create = vi.fn();
    const update = vi.fn();
    const controller = new CoursesController({ create, update } as never);

    expect(() => controller.create({
      name: '  ',
      defaultUnitPrice: '10.00',
      defaultDurationMinutes: 45,
    })).toThrow('请求参数不合法');
    expect(() => controller.create({
      name: '主课',
      defaultUnitPrice: 10,
      defaultDurationMinutes: 45,
    })).toThrow('请求参数不合法');
    expect(() => controller.create({
      name: '主课',
      defaultUnitPrice: '10.0',
      defaultDurationMinutes: 45,
    })).toThrow('请求参数不合法');
    expect(() => controller.create({
      name: '主课',
      defaultUnitPrice: 'not-an-amount',
      defaultDurationMinutes: 45,
    })).toThrow('请求参数不合法');
    expect(() => controller.create({
      name: '主课',
      defaultUnitPrice: '-1.00',
      defaultDurationMinutes: 45,
    })).toThrow('请求参数不合法');
    expect(() => controller.create({
      name: '主课',
      defaultUnitPrice: '001.00',
      defaultDurationMinutes: 45,
    })).toThrow('请求参数不合法');
    expect(() => controller.create({
      name: '主课',
      defaultUnitPrice: '10.00',
      defaultDurationMinutes: 481,
    })).toThrow('请求参数不合法');
    expect(() => controller.update('2ec91ef0-5d8a-4eef-a8f2-5690923dc69d', {})).toThrow('请求参数不合法');
    expect(() => controller.update('2ec91ef0-5d8a-4eef-a8f2-5690923dc69d', {
      name: '新名称',
      extra: true,
    })).toThrow('请求参数不合法');

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('trims valid names and forwards only valid fields', async () => {
    const create = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const controller = new CoursesController({ create, update } as never);

    controller.create({ name: ' 主课 ', defaultUnitPrice: '0.00', defaultDurationMinutes: 1 });
    await controller.update('2ec91ef0-5d8a-4eef-a8f2-5690923dc69d', {
      name: ' 陪练 ',
      defaultUnitPrice: '120.50',
      isActive: false,
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: '主课',
      defaultUnitPrice: expect.any(Prisma.Decimal),
      defaultDurationMinutes: 1,
    }));
    expect(update).toHaveBeenCalledWith('2ec91ef0-5d8a-4eef-a8f2-5690923dc69d', expect.objectContaining({
      name: '陪练',
      defaultUnitPrice: expect.any(Prisma.Decimal),
      isActive: false,
    }));
    expect(create.mock.calls[0]?.[0].defaultUnitPrice.toFixed(2)).toBe('0.00');
    expect(update.mock.calls[0]?.[1].defaultUnitPrice.toFixed(2)).toBe('120.50');
  });
});
