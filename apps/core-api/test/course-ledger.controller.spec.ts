import 'reflect-metadata';
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
});
