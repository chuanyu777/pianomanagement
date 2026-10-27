import { withBusinessTime } from '../../common/time/business-clock.js';
import { DashboardService } from './dashboard.service.js';
import { describe, expect, it, vi } from 'vitest';

describe('DashboardService', () => {
  it('builds an owner overview from Core read services without recalculating money in the browser', async () => {
    const lessons = { listForActorInRange: vi.fn().mockResolvedValue([{
      id: 'lesson-1', accountId: 'account-1', teacherId: 'teacher-1',
      startsAt: new Date('2026-10-26T02:00:00.000Z'), endsAt: new Date('2026-10-26T03:00:00.000Z'), status: 'SCHEDULED',
      student: { id: 'student-1', name: '小琴' }, course: { id: 'course-1', name: '钢琴课' }, teacher: { id: 'teacher-1', name: '周老师' },
    }]) };
    const students = { list: vi.fn().mockResolvedValue([{ enrollmentStatus: 'FROZEN' }, { enrollmentStatus: 'STUDYING' }]) };
    const reports = { monthly: vi.fn().mockResolvedValue({ operatingProfit: '800.00', cashNet: '500.00' }) };
    const periods = { preclose: vi.fn().mockResolvedValue({ period: '2026-10', closed: false, unpaidPayrolls: [{ payrollId: 'payroll-1' }], blockers: [{ code: 'PENDING_LESSONS', count: 1, message: '有 1 节待确认课程' }] }) };
    const repository = { ownerFacts: vi.fn().mockResolvedValue({ arrearsCount: 2, recentRecords: [] }) };
    const service = new DashboardService(lessons as never, students as never, reports as never, periods as never, repository as never);

    const result = await withBusinessTime(new Date('2026-10-26T04:00:00.000Z'), () => service.overview({ id: 'owner-1', username: 'owner', role: 'OWNER' }));

    expect(result).toMatchObject({
      businessDate: '2026-10-26',
      today: { total: 1, pendingCount: 1, completedCount: 0 },
      students: { total: 2, frozenCount: 1, arrearsCount: 2 },
      finance: { period: '2026-10', operatingProfit: '800.00', cashNet: '500.00' },
      preclose: { closed: false, unpaidPayrollCount: 1, blockers: [{ count: 1 }] },
    });
    expect(lessons.listForActorInRange).toHaveBeenCalledWith(expect.objectContaining({ role: 'OWNER' }), {
      startsAt: new Date('2026-10-25T16:00:00.000Z'), endsAt: new Date('2026-10-26T16:00:00.000Z'),
    });
  });

  it('keeps owner-only student and finance data out of a teacher overview', async () => {
    const lessons = { listForActorInRange: vi.fn().mockResolvedValue([]) };
    const students = { list: vi.fn() }; const reports = { monthly: vi.fn() }; const periods = { preclose: vi.fn() };
    const repository = { ownerFacts: vi.fn() };
    const service = new DashboardService(lessons as never, students as never, reports as never, periods as never, repository as never);
    const result = await service.overview({ id: 'teacher-user', username: 'teacher', role: 'TEACHER', teacherId: 'teacher-1' });
    expect(result).toMatchObject({ students: null, finance: null, preclose: null });
    expect(students.list).not.toHaveBeenCalled(); expect(reports.monthly).not.toHaveBeenCalled(); expect(periods.preclose).not.toHaveBeenCalled();
    expect(repository.ownerFacts).not.toHaveBeenCalled();
  });
});
