import { describe, expect, it, vi } from 'vitest';
import { AssistantActionsController, AssistantPreviewConfirmController } from './assistant-actions.controller.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { REQUIRED_ROLES } from '../auth/roles.decorator.js';
import { CAPABILITY_PERMISSION } from '../../common/capability/requires-capability.js';
import { InternalRequestGuard } from '../../common/internal-auth/internal-request.guard.js';
import { CapabilityGuard } from '../../common/capability/capability.guard.js';

describe('Assistant Actions controllers', () => {
  it('keeps preview behind internal Capability and confirmation behind public JWT plus role guards', () => {
    expect(Reflect.getMetadata('__guards__', AssistantActionsController)).toEqual([InternalRequestGuard, CapabilityGuard]);
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createSingleLessonPreview)).toBe('PREVIEW_L1');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createBatchLessonPreview)).toBe('PREVIEW_L1');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createReschedulePreview)).toBe('PREVIEW_L1');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createCancelPreview)).toBe('PREVIEW_L1');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createCompletionPreview)).toBe('PREVIEW_L2');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createCompletionReversalPreview)).toBe('PREVIEW_L2');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createCompletionCorrectionPreview)).toBe('PREVIEW_L2');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createPaymentPreview)).toBe('PREVIEW_L2');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createGiftPreview)).toBe('PREVIEW_L2');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.previewFinalRefund)).toBe('PREVIEW_L2');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createStructuredActionPreview)).toBe('PREVIEW_L2');
    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.invalidatePreview)).toBe('READ');
    expect(Reflect.getMetadata('__guards__', AssistantPreviewConfirmController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLES, AssistantPreviewConfirmController)).toEqual(['OWNER', 'TEACHER']);
  });
  it('binds internal Preview to the authenticated Capability subject and run', async () => {
    const service = { createSingleLessonPreview: vi.fn(async (input) => input) };
    const controller = new AssistantActionsController(service as never);
    const result = await controller.createSingleLessonPreview({
      accountId: '9b50ce88-0db0-4b02-8a33-11ebd45d8ee3',
      teacherId: '888a5319-30bd-4db6-a915-8f10d3f19b38',
      startsAt: '2026-11-02T09:00:00+08:00',
      idempotencyKey: '392c6583-b831-4073-bb34-f3f923c3590b',
      requestId: 'e795886b-4024-4758-94f1-19a90e03914e',
    }, { capability: { sub: 'owner-1', runId: 'run-1' } } as never);
    expect(result).toMatchObject({ actorUserId: 'owner-1', runId: 'run-1', startsAt: new Date('2026-11-02T01:00:00.000Z') });
    expect(service.createSingleLessonPreview).toHaveBeenCalledOnce();
  });

  it('binds normalized weekly batch Preview to the Capability and rejects invalid week counts', async () => {
    const service = { createBatchLessonPreview: vi.fn(async (input) => input) };
    const controller = new AssistantActionsController(service as never);
    const result = await controller.createBatchLessonPreview({
      accountId: '9b50ce88-0db0-4b02-8a33-11ebd45d8ee3',
      teacherId: '888a5319-30bd-4db6-a915-8f10d3f19b38',
      firstStartsAt: '2026-11-02T09:00:00+08:00', weeks: 3,
      idempotencyKey: '392c6583-b831-4073-bb34-f3f923c3590b',
      requestId: 'e795886b-4024-4758-94f1-19a90e03914e',
    }, { capability: { sub: 'owner-1', runId: 'run-1' } } as never);
    expect(result).toMatchObject({ actorUserId: 'owner-1', runId: 'run-1', weeks: 3,
      firstStartsAt: new Date('2026-11-02T01:00:00.000Z') });
    expect(service.createBatchLessonPreview).toHaveBeenCalledOnce();
    expect(() => controller.createBatchLessonPreview({
      accountId: '9b50ce88-0db0-4b02-8a33-11ebd45d8ee3',
      teacherId: '888a5319-30bd-4db6-a915-8f10d3f19b38',
      firstStartsAt: '2026-11-02T09:00:00+08:00', weeks: 53,
      idempotencyKey: '392c6583-b831-4073-bb34-f3f923c3590b',
      requestId: 'e795886b-4024-4758-94f1-19a90e03914e',
    }, { capability: { sub: 'owner-1', runId: 'run-1' } } as never)).toThrow('请求参数不合法');
  });

  it('binds final refund Preview to the Capability and normalizes the date', async () => {
    const service = { previewFinalRefund: vi.fn(async (input) => input) };
    const controller = new AssistantActionsController(service as never);
    const result = await controller.previewFinalRefund({
      studentId: '9b50ce88-0db0-4b02-8a33-11ebd45d8ee3', feeAmount: '10.00', channel: 'CASH',
      occurredAt: '2026-11-02T09:00:00+08:00',
      idempotencyKey: '392c6583-b831-4073-bb34-f3f923c3590b',
      requestId: 'e795886b-4024-4758-94f1-19a90e03914e',
    }, { capability: { sub: 'owner-1', runId: 'run-1' } } as never);
    expect(result).toMatchObject({ actorUserId: 'owner-1', runId: 'run-1', feeAmount: '10.00',
      occurredAt: new Date('2026-11-02T01:00:00.000Z') });
    expect(service.previewFinalRefund).toHaveBeenCalledOnce();
  });

  it('binds a browser weekly batch Preview to the logged-in actor', async () => {
    const service = { createBatchLessonPreview: vi.fn(async (input) => input) };
    const controller = new AssistantPreviewConfirmController(service as never);
    const requestId = 'e795886b-4024-4758-94f1-19a90e03914e';
    const result = await controller.createBatchLessons({
      accountId: '9b50ce88-0db0-4b02-8a33-11ebd45d8ee3', teacherId: '888a5319-30bd-4db6-a915-8f10d3f19b38',
      firstStartsAt: '2026-11-02T09:00:00+08:00', weeks: 8,
      idempotencyKey: '392c6583-b831-4073-bb34-f3f923c3590b', requestId,
    }, { actor: { id: 'owner-1', role: 'OWNER' } } as never);
    expect(result).toMatchObject({ actorUserId: 'owner-1', runId: `browser:owner-1:${requestId}`, weeks: 8 });
  });

  it('routes confirmation through the logged-in actor and idempotency key', async () => {
    const actor = { id: 'teacher-user', role: 'TEACHER', teacherId: 'teacher-1' };
    const service = { confirmPreview: vi.fn(async () => ({ status: 'EXECUTED' })) };
    const controller = new AssistantPreviewConfirmController(service as never);
    const result = await controller.confirm('d3b5907f-612b-4749-bec0-c5a6268a5411',
      'e795886b-4024-4758-94f1-19a90e03914e', { actor } as never);
    expect(result).toEqual({ status: 'EXECUTED' });
    expect(service.confirmPreview).toHaveBeenCalledWith(
      'd3b5907f-612b-4749-bec0-c5a6268a5411', actor, 'e795886b-4024-4758-94f1-19a90e03914e',
    );
  });

  it('rejects malformed preview commands before calling the service', () => {
    const service = { createSingleLessonPreview: vi.fn() };
    const controller = new AssistantActionsController(service as never);
    expect(() => controller.createSingleLessonPreview({}, { capability: { sub: 'owner', runId: 'run' } } as never))
      .toThrow('请求参数不合法');
    expect(service.createSingleLessonPreview).not.toHaveBeenCalled();
  });

  it('binds the unified structured action Preview to the Capability subject and run', async () => {
    const service = { createStructuredActionPreview: vi.fn(async (input) => input) };
    const controller = new AssistantActionsController(service as never);
    const result = await controller.createStructuredActionPreview({
      actionType: 'manual-transaction.create',
      command: { kind: 'INCOME', incomeCategory: 'BOOK_SALE', amount: '100.00', channel: 'CASH', occurredAt: '2026-11-02T09:00:00+08:00' },
      idempotencyKey: '392c6583-b831-4073-bb34-f3f923c3590b',
      requestId: 'e795886b-4024-4758-94f1-19a90e03914e',
    }, { capability: { sub: 'owner-1', runId: 'run-1' } } as never);
    expect(result).toMatchObject({ actionType: 'manual-transaction.create', actorUserId: 'owner-1', runId: 'run-1' });
    expect(service.createStructuredActionPreview).toHaveBeenCalledOnce();
  });

  it('exposes actor-bound internal preview invalidation with a reason-only body', async () => {
    const service = { invalidatePreview: vi.fn(async (...input: unknown[]) => input) };
    const controller = new AssistantActionsController(service as never);
    const result = await controller.invalidatePreview(
      'd3b5907f-612b-4749-bec0-c5a6268a5411',
      { reason: '用户修改了时间' },
      { capability: { sub: 'teacher-user', permissions: ['READ', 'PREVIEW_L1'] } } as never,
    );
    expect(result).toEqual(['d3b5907f-612b-4749-bec0-c5a6268a5411', 'teacher-user', '用户修改了时间']);
  });
});
