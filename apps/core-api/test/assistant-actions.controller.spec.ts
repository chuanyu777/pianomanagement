import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityGuard } from '../src/common/capability/capability.guard.js';
import { CAPABILITY_PERMISSION } from '../src/common/capability/requires-capability.js';
import { AssistantActionsController } from '../src/modules/assistant-actions/assistant-actions.controller.js';

describe('AssistantActionsController', () => {
  it('declares PREVIEW_L1 and maps the Capability identity to the service', async () => {
    const createTechnicalSpikePreview = vi.fn(async (input) => ({ input }));
    const controller = new AssistantActionsController({
      createTechnicalSpikePreview,
    } as never);
    const request = {
      headers: {},
      capability: {
        iss: 'piano-core' as const,
        aud: 'piano-core-internal' as const,
        sub: 'owner-1',
        runId: 'run-1',
        permissions: ['PREVIEW_L1' as const],
        threadId: 'c33c4244-2c78-4b25-b6d3-b62daf712dc5',
        jti: '92228f7e-91a6-450c-b124-910ae76d4ef7',
        iat: 1,
        exp: 2,
      },
    };

    await controller.createPreview(
      { idempotencyKey: 'key-1', requestId: 'request-1' },
      request,
    );

    expect(Reflect.getMetadata(CAPABILITY_PERMISSION, AssistantActionsController.prototype.createPreview)).toBe(
      'PREVIEW_L1',
    );
    expect(Reflect.getMetadata('__guards__', AssistantActionsController)).toContain(CapabilityGuard);
    expect(createTechnicalSpikePreview).toHaveBeenCalledWith({
      actorUserId: 'owner-1',
      runId: 'run-1',
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
  });

  it('rejects malformed input before calling the service', async () => {
    const createTechnicalSpikePreview = vi.fn();
    const controller = new AssistantActionsController({ createTechnicalSpikePreview } as never);

    expect(() =>
      controller.createPreview(
        { idempotencyKey: '', requestId: 42 },
        { headers: {}, capability: {} } as never,
      ),
    ).toThrow('请求参数不合法');
    expect(createTechnicalSpikePreview).not.toHaveBeenCalled();
  });
});
