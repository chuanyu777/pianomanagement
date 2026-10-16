import { Prisma } from '../src/generated/prisma/client.js';
import { CoursesService } from '../src/modules/courses/courses.service.js';
import { describe, expect, it, vi } from 'vitest';

const course = {
  id: '2ec91ef0-5d8a-4eef-a8f2-5690923dc69d',
  name: ' 钢琴主课 ',
  defaultUnitPrice: new Prisma.Decimal('380.00'),
  defaultDurationMinutes: 45,
  isActive: true,
};

describe('CoursesService', () => {
  it('creates a course with a Decimal price and returns a two-decimal string', async () => {
    const create = vi.fn(async () => ({ ...course, name: '钢琴主课' }));
    const service = new CoursesService({ course: { create } } as never);

    const result = await service.create({
      name: ' 钢琴主课 ',
      defaultUnitPrice: new Prisma.Decimal('380.00'),
      defaultDurationMinutes: 45,
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        name: '钢琴主课',
        defaultUnitPrice: expect.any(Prisma.Decimal),
        defaultDurationMinutes: 45,
      },
      select: expect.any(Object),
    });
    expect(create.mock.calls[0]?.[0].data.defaultUnitPrice.toString()).toBe('380');
    expect(result).toEqual({
      id: course.id,
      name: '钢琴主课',
      defaultUnitPrice: '380.00',
      defaultDurationMinutes: 45,
      isActive: true,
    });
  });

  it('lists courses with normalized price strings', async () => {
    const findMany = vi.fn(async () => [{ ...course, name: '钢琴主课' }]);
    const service = new CoursesService({ course: { findMany } } as never);

    await expect(service.list()).resolves.toEqual([{
      id: course.id,
      name: '钢琴主课',
      defaultUnitPrice: '380.00',
      defaultDurationMinutes: 45,
      isActive: true,
    }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    }));
  });

  it('updates only supplied fields and converts a price string to Decimal', async () => {
    const update = vi.fn(async () => ({ ...course, name: '陪练', defaultUnitPrice: new Prisma.Decimal('120.50') }));
    const service = new CoursesService({ course: { update } } as never);

    const result = await service.update(course.id, {
      name: '陪练',
      defaultUnitPrice: new Prisma.Decimal('120.50'),
      isActive: false,
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: course.id },
      data: {
        name: '陪练',
        defaultUnitPrice: expect.any(Prisma.Decimal),
        isActive: false,
      },
    }));
    expect(result.defaultUnitPrice).toBe('120.50');
  });
});
