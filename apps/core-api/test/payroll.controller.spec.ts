import { BadRequestException } from '@nestjs/common';
import { PayrollController } from '../src/modules/payroll/payroll.controller.js';
import { describe, expect, it, vi } from 'vitest';

describe('PayrollController', () => {
  it('requires the previewed version and authenticated actor to cancel a payment', () => {
    const cancelPayment = vi.fn();
    const controller = new PayrollController({ cancelPayment } as never);
    const payrollId = '11111111-1111-4111-8111-111111111111';

    expect(() => controller.cancelPayment(payrollId, {}, { actor: { id: 'owner-1' } } as never))
      .toThrow(BadRequestException);
    expect(cancelPayment).not.toHaveBeenCalled();

    controller.cancelPayment(payrollId, { expectedVersion: 4, note: '误操作撤销' }, {
      actor: { id: 'owner-1' },
    } as never);
    expect(cancelPayment).toHaveBeenCalledWith(payrollId, {
      expectedVersion: 4, note: '误操作撤销', actorId: 'owner-1',
    });
  });
});
