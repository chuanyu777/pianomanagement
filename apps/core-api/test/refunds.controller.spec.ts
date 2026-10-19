import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { PaymentChannel, UserRole } from '../src/generated/prisma/client.js';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard.js';
import { REQUIRED_ROLES } from '../src/modules/auth/roles.decorator.js';
import { RolesGuard } from '../src/modules/auth/roles.guard.js';
import { RefundsController } from '../src/modules/refunds/refunds.controller.js';
import { describe, expect, it, vi } from 'vitest';

const studentId = 'd1a2d3e4-1111-4aaa-8bbb-0123456789ab';
const commandId = 'b1a2d3e4-1111-4aaa-8bbb-0123456789ab';
const actor = { id: 'e1a2d3e4-1111-4aaa-8bbb-0123456789ab', username: 'owner', role: UserRole.OWNER };

describe('RefundsController', () => {
  it('requires an owner JWT for refund creation', () => {
    const controller = new RefundsController({ refund: vi.fn() } as never);

    expect(controller).toBeInstanceOf(RefundsController);
    expect(Reflect.getMetadata('__guards__', RefundsController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLES, RefundsController)).toEqual([UserRole.OWNER]);
  });

  it('parses the required UUID idempotency header and passes the refund request to the service', async () => {
    const refund = vi.fn(async () => ({ id: commandId }));
    const controller = new RefundsController({ refund } as never);
    const body = {
      feeAmount: '10.00',
      channel: PaymentChannel.WECHAT,
      occurredAt: '2026-10-17T04:00:00.000Z',
      note: '协商退费',
    };

    await expect(controller.create(studentId, commandId, body, { actor } as never)).resolves.toEqual({ id: commandId });
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({
      studentId,
      feeAmount: '10.00',
      channel: PaymentChannel.WECHAT,
      occurredAt: new Date(body.occurredAt),
      note: '协商退费',
      commandId,
    }), actor);
  });

  it.each([
    ['missing key', undefined],
    ['malformed key', 'not-a-uuid'],
  ])('rejects a %s idempotency key', async (_label, key) => {
    const refund = vi.fn();
    const controller = new RefundsController({ refund } as never);

    expect(() => controller.create(studentId, key, {
      feeAmount: '0.00',
      channel: PaymentChannel.CASH,
      occurredAt: '2026-10-17T04:00:00.000Z',
    }, { actor } as never)).toThrow(BadRequestException);
    expect(refund).not.toHaveBeenCalled();
  });

  it('rejects money values that are not two-decimal strings', async () => {
    const refund = vi.fn();
    const controller = new RefundsController({ refund } as never);

    expect(() => controller.create(studentId, commandId, {
      feeAmount: 10,
      channel: PaymentChannel.CASH,
      occurredAt: '2026-10-17T04:00:00.000Z',
    }, { actor } as never)).toThrow(BadRequestException);
    expect(refund).not.toHaveBeenCalled();
  });
});
