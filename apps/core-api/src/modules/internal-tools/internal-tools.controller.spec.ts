import { describe, expect, it, vi } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { CAPABILITY_PERMISSION } from '../../common/capability/requires-capability.js';
import { CapabilityGuard } from '../../common/capability/capability.guard.js';
import { InternalRequestGuard } from '../../common/internal-auth/internal-request.guard.js';
import { InternalToolsController } from './internal-tools.controller.js';
import { LessonStatus } from '../../generated/prisma/client.js';

describe('InternalToolsController', () => {
  it('passes the verified capability subject to the Core summary service', async () => {
    const service = { dashboardSummary: vi.fn().mockResolvedValue({ role: 'OWNER' }) };
    const controller = new InternalToolsController(service as never);
    const request = { capability: { sub: 'user-from-capability' } };

    await expect(controller.dashboardSummary(request as never)).resolves.toEqual({ role: 'OWNER' });
    expect(service.dashboardSummary).toHaveBeenCalledWith('user-from-capability');
  });

  it('protects dashboard summary with internal request signature and READ capability', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, InternalToolsController)).toEqual([
      InternalRequestGuard,
      CapabilityGuard,
    ]);
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, InternalToolsController.prototype.dashboardSummary)).toBe('READ');
  });

  it('validates and trims exact candidate names before calling Core', async () => {
    const service = { courseAccountCandidates: vi.fn().mockResolvedValue({ candidates: [] }) };
    const controller = new InternalToolsController(service as never);
    const request = { capability: { sub: 'owner-from-capability' } };

    await expect(controller.courseAccountCandidates(
      { studentName: '  林同学 ', courseName: ' 钢琴 ' }, request as never,
    )).resolves.toEqual({ candidates: [] });
    expect(service.courseAccountCandidates).toHaveBeenCalledWith('owner-from-capability', {
      studentName: '林同学', courseName: '钢琴',
    });
  });

  it('accepts opt-in search matching for every safe candidate endpoint', async () => {
    const service = {
      courseAccountCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
      teacherCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
      studentCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
      lessonCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
    };
    const controller = new InternalToolsController(service as never);
    const request = { capability: { sub: 'owner-from-capability' } };

    await controller.courseAccountCandidates({ studentName: ' 林 ', match: 'search' }, request as never);
    await controller.teacherCandidates({ teacherName: ' 王 ', match: 'search' }, request as never);
    await controller.studentCandidates({ studentName: ' 小明 ', match: 'search' }, request as never);
    await controller.lessonCandidates({ studentName: ' 小明 ', date: '2026-10-19', match: 'search' }, request as never);

    expect(service.courseAccountCandidates).toHaveBeenCalledWith('owner-from-capability', { studentName: '林', match: 'search' });
    expect(service.teacherCandidates).toHaveBeenCalledWith('owner-from-capability', { teacherName: '王', match: 'search' });
    expect(service.studentCandidates).toHaveBeenCalledWith('owner-from-capability', { studentName: '小明', match: 'search' });
    expect(service.lessonCandidates).toHaveBeenCalledWith('owner-from-capability', { studentName: '小明', date: '2026-10-19', match: 'search' });
  });

  it('rejects missing, blank, oversized and unknown candidate query parameters', async () => {
    const controller = new InternalToolsController({ courseAccountCandidates: vi.fn() } as never);
    const request = { capability: { sub: 'owner-from-capability' } };

    for (const query of [
      {},
      { studentName: '  ', courseName: '钢琴' },
      { studentName: '林同学', courseName: '钢琴', extra: 'value' },
      { studentName: 'x'.repeat(101), courseName: '钢琴' },
      { studentName: ['林同学'], courseName: '钢琴' },
      { studentName: '林同学', match: 'contains' },
    ]) {
      expect(() => controller.courseAccountCandidates(query, request as never)).toThrow('请求参数不合法');
    }
  });

  it('protects candidate lookup with internal request signature and READ capability', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, InternalToolsController)).toEqual([
      InternalRequestGuard,
      CapabilityGuard,
    ]);
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, InternalToolsController.prototype.courseAccountCandidates)).toBe('READ');
  });

  it('validates and trims teacher names before calling Core', async () => {
    const service = { teacherCandidates: vi.fn().mockResolvedValue({ candidates: [] }) };
    const controller = new InternalToolsController(service as never);
    const request = { capability: { sub: 'owner-from-capability' } };

    await expect(controller.teacherCandidates({ teacherName: '  王老师 ' }, request as never))
      .resolves.toEqual({ candidates: [] });
    expect(service.teacherCandidates).toHaveBeenCalledWith('owner-from-capability', { teacherName: '王老师' });
  });

  it('rejects missing, blank, oversized and unknown teacher query parameters', () => {
    const controller = new InternalToolsController({ teacherCandidates: vi.fn() } as never);
    const request = { capability: { sub: 'owner-from-capability' } };

    for (const query of [
      {},
      { teacherName: '  ' },
      { teacherName: 'x'.repeat(101) },
      { teacherName: ['王老师'] },
      { teacherName: '王老师', extra: 'value' },
    ]) {
      expect(() => controller.teacherCandidates(query, request as never)).toThrow('请求参数不合法');
    }
  });

  it('protects teacher candidate lookup with internal request signature and READ capability', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, InternalToolsController)).toEqual([
      InternalRequestGuard,
      CapabilityGuard,
    ]);
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, InternalToolsController.prototype.teacherCandidates)).toBe('READ');
  });

  it('validates lesson range filters and protects the typed lesson read with READ capability', async () => {
    const service = { listLessons: vi.fn().mockResolvedValue({ businessDate: '2026-10-21', dateFrom: '2026-10-21', dateTo: '2026-10-22', lessons: [] }) };
    const controller = new InternalToolsController(service as never);
    const request = { capability: { sub: 'teacher-from-capability' } };

    await expect(controller.listLessons({
      dateFrom: '2026-10-21', dateTo: '2026-10-22', studentName: ' 小明 ',
      teacherName: ' 王老师 ', statusText: '待上课',
    }, request as never)).resolves.toEqual({ businessDate: '2026-10-21', dateFrom: '2026-10-21', dateTo: '2026-10-22', lessons: [] });
    expect(service.listLessons).toHaveBeenCalledWith('teacher-from-capability', {
      dateFrom: '2026-10-21', dateTo: '2026-10-22', studentName: '小明', teacherName: '王老师', statusText: '待上课',
    });
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, InternalToolsController.prototype.listLessons)).toBe('READ');

    for (const query of [
      { dateFrom: '2026-10-22', dateTo: '2026-10-21' },
      { dateFrom: '2026-10-21' },
      { dateFrom: '2026/10/21', dateTo: '2026-10-21' },
      { dateFrom: '2026-10-21', dateTo: '2026-10-21', status: 'UNKNOWN' },
      { dateFrom: '2026-10-21', dateTo: '2026-10-21', status: LessonStatus.SCHEDULED, statusText: '待上课' },
      { dateFrom: '2026-10-21', dateTo: '2026-10-21', extra: 'value' },
    ]) {
      expect(() => controller.listLessons(query, request as never)).toThrow('请求参数不合法');
    }
  });

  it('accepts a selected account id for the typed owner account read', async () => {
    const service = { courseAccount: vi.fn().mockResolvedValue({ accountId: 'account-1' }) };
    const controller = new InternalToolsController(service as never);
    const request = { capability: { sub: 'owner-from-capability' } };
    const accountId = '11111111-1111-4111-8111-111111111111';

    await expect(controller.courseAccount({ accountId }, request as never))
      .resolves.toEqual({ accountId: 'account-1' });
    expect(service.courseAccount).toHaveBeenNthCalledWith(1, 'owner-from-capability', { accountId });
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, InternalToolsController.prototype.courseAccount)).toBe('READ');

    for (const query of [{}, { accountId: 'not-a-uuid' }, { studentName: '林同学' }, { accountId, extra: 'value' }]) {
      expect(() => controller.courseAccount(query, request as never)).toThrow('请求参数不合法');
    }
  });

  it('validates month reports, account ledgers, and payroll month queries as READ tools', async () => {
    const service = {
      monthlyReport: vi.fn().mockResolvedValue({ period: '2026-10' }),
      courseAccountLedger: vi.fn().mockResolvedValue({ accountId: 'account-1', entries: [] }),
      monthlyPayroll: vi.fn().mockResolvedValue({ period: '2026-10', payrolls: [] }),
    };
    const controller = new InternalToolsController(service as never);
    const request = { capability: { sub: 'subject-from-capability' } };

    await expect(controller.monthlyReport({ period: '2026-10' }, request as never)).resolves.toMatchObject({ period: '2026-10' });
    await controller.courseAccountLedger({ accountId: '11111111-1111-4111-8111-111111111111' }, request as never);
    await controller.monthlyPayroll({ period: '2026-10' }, request as never);
    expect(service.monthlyReport).toHaveBeenCalledWith('subject-from-capability', { period: '2026-10' });
    expect(service.courseAccountLedger).toHaveBeenCalledWith('subject-from-capability', { accountId: '11111111-1111-4111-8111-111111111111' });
    expect(service.monthlyPayroll).toHaveBeenCalledWith('subject-from-capability', { period: '2026-10' });
    for (const method of ['monthlyReport', 'courseAccountLedger', 'monthlyPayroll'] as const) {
      expect(Reflect.getMetadata(CAPABILITY_PERMISSION, InternalToolsController.prototype[method])).toBe('READ');
    }
    for (const period of ['2026-00', '2026-13', '2026/10']) {
      expect(() => controller.monthlyReport({ period }, request as never)).toThrow('请求参数不合法');
      expect(() => controller.monthlyPayroll({ period }, request as never)).toThrow('请求参数不合法');
    }
  });

  it('exposes directory, arrears/frozen, monthly consumption and preclose as READ tools', async () => {
    const service = {
      directory: vi.fn().mockResolvedValue({ students: [], teachers: [], courses: [] }),
      arrearsAndFrozen: vi.fn().mockResolvedValue({ arrears: [], frozenStudents: [] }),
      monthlyConsumption: vi.fn().mockResolvedValue({ period: '2026-10', courses: [], teachers: [], students: [] }),
      periodPreclose: vi.fn().mockResolvedValue({ period: '2026-10', closed: false, pendingLessons: [], refundAnomalies: [], missingPayrollTeachers: [], ledgerAnomalies: [], reminders: [] }),
    };
    const controller = new InternalToolsController(service as never);
    const request = { capability: { sub: 'owner-from-capability' } };

    await controller.directory(request as never);
    await controller.arrearsAndFrozen(request as never);
    await controller.monthlyConsumption({ period: '2026-10' }, request as never);
    await controller.periodPreclose({ period: '2026-10' }, request as never);
    expect(service.directory).toHaveBeenCalledWith('owner-from-capability');
    expect(service.arrearsAndFrozen).toHaveBeenCalledWith('owner-from-capability');
    expect(service.monthlyConsumption).toHaveBeenCalledWith('owner-from-capability', { period: '2026-10' });
    expect(service.periodPreclose).toHaveBeenCalledWith('owner-from-capability', { period: '2026-10' });
    for (const method of ['directory', 'arrearsAndFrozen', 'monthlyConsumption', 'periodPreclose'] as const) {
      expect(Reflect.getMetadata(CAPABILITY_PERMISSION, InternalToolsController.prototype[method])).toBe('READ');
    }
    for (const period of ['2026-00', '2026-13', '2026/10']) {
      expect(() => controller.monthlyConsumption({ period }, request as never)).toThrow('请求参数不合法');
      expect(() => controller.periodPreclose({ period }, request as never)).toThrow('请求参数不合法');
    }
  });
});
