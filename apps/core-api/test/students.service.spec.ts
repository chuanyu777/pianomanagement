import { StudentsService } from '../src/modules/students/students.service.js';
import { describe, expect, it, vi } from 'vitest';

describe('StudentsService', () => {
  it('creates a student with a trimmed name and nullable notes', async () => {
    const create = vi.fn(async ({ data }) => ({
      id: 'student-1',
      name: data.name,
      phone: data.phone,
      notes: data.notes,
      withdrawnAt: null,
      courseAccounts: [],
      createdAt: new Date('2026-10-16T00:00:00.000Z'),
      updatedAt: new Date('2026-10-16T00:00:00.000Z'),
    }));
    const transaction = vi.fn(async (callback) => callback({ student: { create } }));
    const service = new StudentsService({ $transaction: transaction } as never);

    const result = await service.create({ name: '  林同学  ' });

    expect(create).toHaveBeenCalledWith({
      data: { name: '林同学', phone: null, notes: null },
      select: {
        id: true,
        name: true,
        phone: true,
        notes: true,
        withdrawnAt: true,
        createdAt: true,
        updatedAt: true,
        courseAccounts: { select: { createdAt: true, lessons: { where: { status: 'COMPLETED' }, select: { completedAt: true } } } },
      },
    });
    expect(result).toEqual({
      id: 'student-1',
      name: '林同学',
      phone: null,
      notes: null,
      enrollmentStatus: 'FROZEN',
      createdAt: new Date('2026-10-16T00:00:00.000Z'),
      updatedAt: new Date('2026-10-16T00:00:00.000Z'),
    });
  });

  it('lists students using the public response fields and stable ordering', async () => {
    const findMany = vi.fn(async () => [
      { id: 'student-1', name: '林同学', notes: null, withdrawnAt: null, courseAccounts: [], createdAt: new Date(0), updatedAt: new Date(0) },
    ]);
    const service = new StudentsService({ student: { findMany } } as never);

    const result = await service.list();

    expect(findMany).toHaveBeenCalledWith({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: expect.objectContaining({ id: true, name: true, notes: true, withdrawnAt: true, courseAccounts: expect.any(Object) }),
    });
    expect(result[0]).not.toHaveProperty('withdrawnAt');
  });

  it('updates only supplied fields and supports null to clear notes', async () => {
    const currentUpdatedAt = new Date('2026-10-16T00:00:00.000Z');
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn().mockResolvedValueOnce({ updatedAt: currentUpdatedAt }).mockResolvedValue({
      id: 'student-1', name: '林同学', notes: null, enrollmentStatus: 'FROZEN',
      phone: null,
      withdrawnAt: null,
      courseAccounts: [],
      createdAt: new Date(0),
      updatedAt: new Date(1),
    });
    const transaction = vi.fn(async (callback) => callback({ student: { findUnique, updateMany } }));
    const service = new StudentsService({ $transaction: transaction } as never);

    await service.update('student-1', { notes: null });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'student-1', updatedAt: currentUpdatedAt },
      data: { notes: null },
    });
  });
});
