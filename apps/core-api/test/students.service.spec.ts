import { StudentsService } from '../src/modules/students/students.service.js';
import { describe, expect, it, vi } from 'vitest';

describe('StudentsService', () => {
  it('creates a student with a trimmed name and nullable notes', async () => {
    const create = vi.fn(async ({ data }) => ({
      id: 'student-1',
      name: data.name,
      notes: data.notes,
      withdrawnAt: null,
      courseAccounts: [],
      createdAt: new Date('2026-10-16T00:00:00.000Z'),
      updatedAt: new Date('2026-10-16T00:00:00.000Z'),
    }));
    const service = new StudentsService({ student: { create } } as never);

    const result = await service.create({ name: '  林同学  ' });

    expect(create).toHaveBeenCalledWith({
      data: { name: '林同学', notes: null },
      select: {
        id: true,
        name: true,
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
    const update = vi.fn(async ({ data }) => ({
      id: 'student-1', enrollmentStatus: 'FROZEN',
      name: data.name ?? '林同学',
      notes: data.notes ?? null,
      withdrawnAt: null,
      courseAccounts: [],
      createdAt: new Date(0),
      updatedAt: new Date(1),
    }));
    const service = new StudentsService({ student: { update } } as never);

    await service.update('student-1', { notes: null });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'student-1' },
      data: { notes: null },
      select: expect.objectContaining({ id: true, name: true, notes: true, withdrawnAt: true, courseAccounts: expect.any(Object) }),
    });
  });
});
