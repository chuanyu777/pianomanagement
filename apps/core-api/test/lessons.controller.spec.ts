import { describe, expect, it, vi } from 'vitest';
import { LessonsController } from '../src/modules/lessons/lessons.controller.js';

describe('LessonsController schedule range', () => {
  const actor = { role: 'TEACHER', teacherId: 'teacher-1' };
  it('converts an offset range to UTC while retaining the authenticated actor', () => {
    const listForActor = vi.fn();
    const controller = new LessonsController({ listForActor } as never);
    controller.list({ actor } as never, { from: '2026-10-26T00:00:00+08:00', to: '2026-11-02T00:00:00+08:00' });
    expect(listForActor).toHaveBeenCalledWith(actor, { from: new Date('2026-10-25T16:00:00Z'), to: new Date('2026-11-01T16:00:00Z') });
  });

  it.each([
    { from: '2026-10-26T00:00:00+08:00' },
    { from: '2026-10-26T00:00:00+08:00', to: '2026-10-26T00:00:00+08:00' },
    { from: '2026-01-01T00:00:00Z', to: '2026-05-01T00:00:00Z' },
    { from: '2026-10-26', to: '2026-11-02' },
  ])('rejects invalid or unbounded ranges', (query) => {
    const listForActor = vi.fn();
    const controller = new LessonsController({ listForActor } as never);
    expect(() => controller.list({ actor } as never, query)).toThrow('查询时间范围不合法');
    expect(listForActor).not.toHaveBeenCalled();
  });
});
