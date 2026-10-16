import { UserRole } from '../src/generated/prisma/client.js';
import { TeachersService } from '../src/modules/teachers/teachers.service.js';
import { describe, expect, it, vi } from 'vitest';

describe('TeachersService', () => {
  it('creates a teacher login and teacher profile in one transaction', async () => {
    const createUser = vi.fn(async () => ({ id: 'd63788c6-8e3f-4e98-9a10-720af1cbd997' }));
    const createTeacher = vi.fn(async () => ({
      id: 'a4952324-d3cb-4983-ae8e-e8c35dafcfa7',
      name: '王老师',
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
    });
  });
});
