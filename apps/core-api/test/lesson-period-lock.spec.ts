import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { LessonsService } from '../src/modules/lessons/lessons.service.js';

describe('课消变更与关账的并发顺序', () => {
  it.each(['reverse', 'correct'] as const)('%s 先检查并锁定账期，再锁定账户', async (action) => {
    const lockAccount = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
        if (parts.join('').includes('StudentCourseAccount')) lockAccount();
        return [{ id: 'id' }];
      }),
      lesson: { findUnique: vi.fn(async () => ({ status:'COMPLETED', accountId:'account-1', account:{version:1} })) },
      ledgerEntry: { findUnique: vi.fn(async ({where}: {where:Record<string,string>}) => where.lessonId ? { id:'entry-1',accountId:'account-1',kind:'LESSON_CONSUMPTION',paidDelta:new Prisma.Decimal('-100'),giftDelta:new Prisma.Decimal(0) } : null) },
    };
    const periods = { assertWritableForDate: vi.fn(async () => { throw new Error('period closed'); }) };
    const service = new LessonsService({} as never, periods as never);
    const owner = {id:'owner-1',username:'owner',role:'OWNER' as const};
    const result = action === 'reverse'
      ? service.reverseCompletionInTransaction(tx as never,'lesson-1',{commandId:'command-1'},owner)
      : service.correctCompletionAmountInTransaction(tx as never,'lesson-1',{commandId:'command-1',correctedUnitPrice:new Prisma.Decimal('80')},owner);
    await expect(result).rejects.toThrow('period closed');
    expect(lockAccount).not.toHaveBeenCalled();
  });
});
