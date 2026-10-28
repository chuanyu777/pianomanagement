import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ReportsController } from '../src/modules/reports/reports.controller.js';

describe('ReportsController cash flow query', () => {
  it('converts the Shanghai business date to a half-open UTC range', async () => {
    const reports = { cashFlow: vi.fn().mockResolvedValue({ items: [] }) };
    const controller = new ReportsController(reports as never);

    await controller.cashFlow('2026-10-27');

    expect(reports.cashFlow).toHaveBeenCalledWith({
      periodType: 'DAY', period: '2026-10-27',
      range: { start: new Date('2026-10-26T16:00:00.000Z'), end: new Date('2026-10-27T16:00:00.000Z') },
    });
  });

  it('accepts business months and rejects missing, ambiguous, and invalid ranges', async () => {
    const reports = { cashFlow: vi.fn().mockResolvedValue({ items: [] }) };
    const controller = new ReportsController(reports as never);

    await controller.cashFlow(undefined, '2026-10');
    expect(reports.cashFlow).toHaveBeenCalledWith({
      periodType: 'MONTH', period: '2026-10',
      range: { start: new Date('2026-09-30T16:00:00.000Z'), end: new Date('2026-10-31T16:00:00.000Z') },
    });
    expect(() => controller.cashFlow()).toThrow(BadRequestException);
    expect(() => controller.cashFlow('2026-10-27', '2026-10')).toThrow(BadRequestException);
    expect(() => controller.cashFlow('2026-02-30')).toThrow(BadRequestException);
    expect(() => controller.cashFlow(undefined, '2026-13')).toThrow(BadRequestException);
  });
});
