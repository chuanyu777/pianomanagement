import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { UserRole } from '../src/generated/prisma/client.js';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard.js';
import { REQUIRED_ROLES } from '../src/modules/auth/roles.decorator.js';
import { RolesGuard } from '../src/modules/auth/roles.guard.js';
import { CourseLedgerController } from '../src/modules/course-ledger/course-ledger.controller.js';
import { describe, expect, it, vi } from 'vitest';

describe('CourseLedgerController', () => {
  it('requires an owner JWT for every balance and money-writing endpoint', () => {
    const controller = new CourseLedgerController({
      getBalance: vi.fn(),
      listEntries: vi.fn(),
      recordPayment: vi.fn(),
      recordGift: vi.fn(),
      reverseEntry: vi.fn(),
    } as never);

    expect(controller).toBeInstanceOf(CourseLedgerController);
    expect(Reflect.getMetadata('__guards__', CourseLedgerController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(REQUIRED_ROLES, CourseLedgerController)).toEqual([UserRole.OWNER]);
  });

  it('exposes the selected course account ledger through the owner-protected controller', async () => {
    const listEntries = vi.fn().mockResolvedValue({ accountId: '11111111-1111-4111-8111-111111111111', entries: [] });
    const controller = new CourseLedgerController({ getBalance: vi.fn(), listEntries, recordPayment: vi.fn(), recordGift: vi.fn(), reverseEntry: vi.fn() } as never);
    await expect(controller.getLedger('11111111-1111-4111-8111-111111111111')).resolves.toEqual({ accountId: '11111111-1111-4111-8111-111111111111', entries: [] });
    expect(listEntries).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  });

  it('requires the account version on a reversal and forwards it with the authenticated actor', () => {
    const reverseEntry = vi.fn();
    const controller = new CourseLedgerController({
      getBalance: vi.fn(), listEntries: vi.fn(), recordPayment: vi.fn(), recordGift: vi.fn(), reverseEntry,
    } as never);
    const entryId = '11111111-1111-4111-8111-111111111111';
    const commandId = '22222222-2222-4222-8222-222222222222';
    const occurredAt = '2026-10-16T02:00:00.000Z';

    expect(() => controller.reverseEntry(entryId, commandId, { actor: { id: 'owner-1' } } as never, {
      occurredAt,
    })).toThrow(BadRequestException);
    expect(reverseEntry).not.toHaveBeenCalled();

    controller.reverseEntry(entryId, commandId, { actor: { id: 'owner-1' } } as never, {
      occurredAt, accountVersion: 7, note: '重复登记冲正',
    });
    expect(reverseEntry).toHaveBeenCalledWith({
      entryId, accountVersion: 7, occurredAt: new Date(occurredAt), note: '重复登记冲正',
      createdById: 'owner-1', commandId,
    });
  });
});
