import { describe, expect, it, vi } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { CAPABILITY_PERMISSION } from '../../common/capability/requires-capability.js';
import { CapabilityGuard } from '../../common/capability/capability.guard.js';
import { InternalRequestGuard } from '../../common/internal-auth/internal-request.guard.js';
import { InternalToolsController } from './internal-tools.controller.js';

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

  it('rejects missing, blank, oversized and unknown candidate query parameters', async () => {
    const controller = new InternalToolsController({ courseAccountCandidates: vi.fn() } as never);
    const request = { capability: { sub: 'owner-from-capability' } };

    for (const query of [
      { studentName: '林同学' },
      { studentName: '  ', courseName: '钢琴' },
      { studentName: '林同学', courseName: '钢琴', extra: 'value' },
      { studentName: 'x'.repeat(101), courseName: '钢琴' },
      { studentName: ['林同学'], courseName: '钢琴' },
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
});
