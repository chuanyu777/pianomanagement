import { describe, expect, it } from 'vitest';
import { filterLedgerEntries } from './ledger-filter.js';

describe('account ledger filters', () => {
  it('filters type and inclusive Shanghai business dates without changing amounts', () => {
    const entries = [
      { kind: 'PAYMENT', occurredAt: '2026-10-27T16:10:00.000Z', amount: '100.00' },
      { kind: 'GIFT', occurredAt: '2026-10-28T04:00:00.000Z', amount: '20.00' },
      { kind: 'PAYMENT', occurredAt: '2026-10-26T00:00:00.000Z', amount: '30.00' },
    ];
    expect(filterLedgerEntries(entries, { kind: 'PAYMENT', from: '2026-10-28', to: '2026-10-28' })).toEqual([entries[0]]);
    expect(filterLedgerEntries(entries, { kind: 'ALL', from: '2026-10-28', to: '2026-10-28' })).toEqual(entries.slice(0, 2));
  });
});
