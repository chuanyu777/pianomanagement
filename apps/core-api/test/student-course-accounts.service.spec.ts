import { Prisma } from '../src/generated/prisma/client.js';
import { StudentCourseAccountsService } from '../src/modules/student-course-accounts/student-course-accounts.service.js';
import { describe, expect, it, vi } from 'vitest';

describe('StudentCourseAccountsService', () => {
  it('copies the course default price when creating an account and increments version on later price changes', async () => {
    const findCourse = vi.fn(async () => ({ defaultUnitPrice: new Prisma.Decimal('180.00') }));
    const createAccount = vi.fn(async () => ({
      id: 'cbe8c144-6f2e-4cea-9548-ee3931084e03',
      studentId: '73d3ad58-f329-4e14-aef4-d794470f69fd',
      courseId: '6f902d86-79dd-4d3d-a86b-55e111c3d912',
      currentUnitPrice: new Prisma.Decimal('180.00'),
      version: 0,
      course: { name: '主课', defaultDurationMinutes: 60 },
    }));
    const updateAccount = vi.fn(async () => ({
      id: 'cbe8c144-6f2e-4cea-9548-ee3931084e03',
      studentId: '73d3ad58-f329-4e14-aef4-d794470f69fd',
      courseId: '6f902d86-79dd-4d3d-a86b-55e111c3d912',
      currentUnitPrice: new Prisma.Decimal('200.00'),
      version: 1,
      course: { name: '主课', defaultDurationMinutes: 60 },
    }));
    const transaction = vi.fn(async (callback) => callback({
      course: { findUnique: findCourse },
      studentCourseAccount: { create: createAccount, update: updateAccount },
    }));
    const service = new StudentCourseAccountsService({ $transaction: transaction } as never);

    const created = await service.create('73d3ad58-f329-4e14-aef4-d794470f69fd', {
      courseId: '6f902d86-79dd-4d3d-a86b-55e111c3d912',
    });
    const updated = await service.updatePrice(created.id, { currentUnitPrice: new Prisma.Decimal('200.00') });

    expect(findCourse).toHaveBeenCalledWith({
      where: { id: '6f902d86-79dd-4d3d-a86b-55e111c3d912' },
      select: { defaultUnitPrice: true },
    });
    expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        studentId: '73d3ad58-f329-4e14-aef4-d794470f69fd',
        courseId: '6f902d86-79dd-4d3d-a86b-55e111c3d912',
        currentUnitPrice: new Prisma.Decimal('180.00'),
      }),
    }));
    expect(updateAccount).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentUnitPrice: new Prisma.Decimal('200.00'), version: { increment: 1 } },
    }));
    expect(created.currentUnitPrice).toBe('180.00');
    expect(updated).toMatchObject({ currentUnitPrice: '200.00', version: 1 });
  });

  it('does not disguise a missing student as an empty account list', async () => {
    const findStudent = vi.fn(async () => null);
    const findAccounts = vi.fn();
    const service = new StudentCourseAccountsService({
      student: { findUnique: findStudent },
      studentCourseAccount: { findMany: findAccounts },
    } as never);

    await expect(service.listForStudent('73d3ad58-f329-4e14-aef4-d794470f69fd')).rejects.toMatchObject({
      status: 404,
      message: '学生不存在',
    });
    expect(findAccounts).not.toHaveBeenCalled();
  });
});
