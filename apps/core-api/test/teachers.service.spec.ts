import { UserRole } from '../src/generated/prisma/client.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { TeachersService } from '../src/modules/teachers/teachers.service.js';
import { describe, expect, it, vi } from 'vitest';

describe('TeachersService', () => {
  it('creates a teacher login and teacher profile in one transaction', async () => {
    const createUser = vi.fn(async () => ({ id: 'd63788c6-8e3f-4e98-9a10-720af1cbd997' }));
    const createTeacher = vi.fn(async () => ({
      id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7',
      name: '王老师',
      isActive: true,
      defaultBaseSalary: new Prisma.Decimal('0.00'),
      defaultCommissionRate: new Prisma.Decimal('0.0000'),
      user: { id: 'd63788c6-8e3f-4e98-9a10-720af1cbd997', username: 'teacher.wang', role: UserRole.TEACHER },
    }));
    const transaction = vi.fn(async (callback) => callback({
      user: { create: createUser },
      teacher: { create: createTeacher },
    }));
    const service = new TeachersService({ $transaction: transaction } as never);

    const result = await service.create({
      username: ' teacher.wang ',
      password: 'a-safe-teacher-password',
      name: ' 王老师 ',
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ username: 'teacher.wang', role: UserRole.TEACHER }),
    }));
    expect(createTeacher).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'd63788c6-8e3f-4e98-9a10-720af1cbd997', name: '王老师' }),
    }));
    expect(result).toEqual({
      id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7',
      name: '王老师',
      userId: 'd63788c6-8e3f-4e98-9a10-720af1cbd997',
      username: 'teacher.wang',
      isActive: true,
      defaultBaseSalary: '0.00',
      defaultCommissionRate: '0.0000',
    });
  });

  it('creates a teacher profile without creating or inventing a login account', async () => {
    const profile = {
      id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7',
      name: '赵老师',
      isActive: true,
      defaultBaseSalary: new Prisma.Decimal('2000.00'),
      defaultCommissionRate: new Prisma.Decimal('10.0000'),
      user: null,
    };
    const createProfile = vi.fn(async () => profile);
    const service = new TeachersService({ teacher: { create: createProfile } } as never);

    const result = await service.create({
      name: ' 赵老师 ',
      defaultBaseSalary: new Prisma.Decimal('2000.00'),
      defaultCommissionRate: new Prisma.Decimal('10.0000'),
    });

    expect(createProfile).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        name: '赵老师',
        defaultBaseSalary: new Prisma.Decimal('2000.00'),
        defaultCommissionRate: new Prisma.Decimal('10.0000'),
      },
    }));
    expect(result).toEqual({
      id: profile.id,
      name: '赵老师',
      userId: null,
      username: null,
      isActive: true,
      defaultBaseSalary: '2000.00',
      defaultCommissionRate: '10.0000',
    });
  });

  it('creates a profile through the caller transaction for Assistant Confirm', async () => {
    const createProfile = vi.fn(async () => ({
      id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7',
      name: '赵老师',
      isActive: true,
      defaultBaseSalary: new Prisma.Decimal('2000.00'),
      defaultCommissionRate: new Prisma.Decimal('10.0000'),
      user: null,
    }));
    const tx = { teacher: { create: createProfile } };
    const service = new TeachersService({} as never);

    await service.createProfileInTransaction(tx as never, {
      name: '赵老师',
      defaultBaseSalary: new Prisma.Decimal('2000.00'),
      defaultCommissionRate: new Prisma.Decimal('10.0000'),
    });

    expect(createProfile).toHaveBeenCalledTimes(1);
  });

  it('updates teacher compensation through the caller transaction', async () => {
    const update = vi.fn(async () => ({
      id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7',
      name: '赵老师',
      isActive: true,
      defaultBaseSalary: new Prisma.Decimal('2500.00'),
      defaultCommissionRate: new Prisma.Decimal('12.5000'),
      user: null,
    }));
    const tx = { teacher: { update } };
    const service = new TeachersService({} as never);

    const result = await service.updateCompensationInTransaction(tx as never, 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7', {
      defaultBaseSalary: new Prisma.Decimal('2500.00'),
      defaultCommissionRate: new Prisma.Decimal('12.5000'),
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7' },
      data: {
        defaultBaseSalary: new Prisma.Decimal('2500.00'),
        defaultCommissionRate: new Prisma.Decimal('12.5000'),
      },
    }));
    expect(result.userId).toBeNull();
    expect(result.username).toBeNull();
  });

  it('requires username and password together when preserving login creation', async () => {
    const service = new TeachersService({} as never);

    await expect(service.create({
      name: '赵老师',
      username: 'teacher.zhao',
    } as never)).rejects.toThrow('用户名和密码必须同时提供');
  });

  it('opens a login account for an existing profile in one transaction', async () => {
    const createUser = vi.fn(async () => ({ id: 'd63788c6-8e3f-4e98-9a10-720af1cbd997' }));
    const updateTeacher = vi.fn(async () => ({
      id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7', name: '王老师', isActive: true,
      defaultBaseSalary: new Prisma.Decimal('0.00'), defaultCommissionRate: new Prisma.Decimal('0.0000'),
      user: { id: 'd63788c6-8e3f-4e98-9a10-720af1cbd997', username: 'teacher.wang' },
    }));
    const transaction = vi.fn(async (callback) => callback({ user: { create: createUser }, teacher: { updateMany: vi.fn(async () => ({ count: 1 })), findUnique: updateTeacher } }));
    const service = new TeachersService({ $transaction: transaction } as never);

    const result = await service.openLoginAccount('a4952324-d3cb-4983-ae8e-e8c35dafcfa7', {
      username: ' teacher.wang ', password: 'a-safe-teacher-password',
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ username: 'teacher.wang', role: UserRole.TEACHER, passwordHash: expect.stringMatching(/^\$2[aby]\$/) }),
      select: { id: true },
    }));
    expect(updateTeacher).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7' }, select: expect.any(Object) }));
    expect(result).toMatchObject({ userId: 'd63788c6-8e3f-4e98-9a10-720af1cbd997', username: 'teacher.wang', name: '王老师' });
    expect(JSON.stringify(result)).not.toContain('a-safe-teacher-password');
  });

  it('rejects a duplicate username from the database unique constraint', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
    const transaction = vi.fn(async (callback) => callback({
      user: { create: vi.fn(async () => { throw duplicate; }) }, teacher: { updateMany: vi.fn(), findUnique: vi.fn() },
    }));
    const service = new TeachersService({ $transaction: transaction } as never);

    await expect(service.openLoginAccount('a4952324-d3cb-4983-ae8e-e8c35dafcfa7', {
      username: 'existing', password: 'a-safe-teacher-password',
    })).rejects.toMatchObject({ status: 409, message: '用户名已存在' });
  });

  it('rolls back account creation when a teacher is already bound', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const transaction = vi.fn(async (callback) => callback({
      user: { create: vi.fn(async () => ({ id: 'new-user' })) }, teacher: { updateMany, findUnique: vi.fn() },
    }));
    const service = new TeachersService({ $transaction: transaction } as never);

    await expect(service.openLoginAccount('a4952324-d3cb-4983-ae8e-e8c35dafcfa7', {
      username: 'another-login', password: 'a-safe-teacher-password',
    })).rejects.toMatchObject({ status: 409, message: '教师已绑定登录账号或资料不存在' });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7', userId: null },
    }));
  });
});
