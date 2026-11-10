import { describe, expect, it } from 'vitest';
import { ledgerPageForEntry, paginateLedger } from './ledger-pagination.js';

describe('account ledger pagination', () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ entryId: `entry-${index}` }));
  it('limits visible records and clamps an out-of-range page after filtering', () => {
    expect(paginateLedger(entries, 2).items.map((entry) => entry.entryId)).toEqual(['entry-5', 'entry-6', 'entry-7', 'entry-8', 'entry-9']);
    expect(paginateLedger(entries.slice(0, 2), 3)).toMatchObject({ page: 1, pages: 1, items: entries.slice(0, 2) });
  });
  it('locates linked records even when they are not on the first page', () => {
    expect(ledgerPageForEntry(entries, 'entry-11')).toBe(3);
    expect(ledgerPageForEntry(entries, 'missing')).toBeNull();
  });
});
