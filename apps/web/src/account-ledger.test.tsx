import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountLedger, type AccountLedgerEntry } from './account-ledger.js';

const entries: AccountLedgerEntry[] = Array.from({ length: 8 }, (_, index) => ({ entryId: `id-${index}`, occurredAt: '2026-11-10T02:00:00Z', kind: index === 7 ? 'GIFT' : 'PAYMENT', amount: `${index}.00`, paidDelta: '0.00', giftDelta: '0.00', note: null, operator: '店主' }));
const props = { accountId: 'account', accountName: '主课', accounts: [{ id: 'account', courseName: '主课' }], scope: 'current', onScope: vi.fn(), entries, loading: false, error: null, linkedEntryId: '', kind: 'ALL', from: '', to: '', onKind: vi.fn(), onFrom: vi.fn(), onTo: vi.fn(), onReverse: vi.fn(), kindLabel: (kind: string) => kind, money: (value: string) => `¥${value}`, formatDate: () => '11/10' };

describe('account ledger', () => {
  it('shows five entries per page and allows changing pages', async () => {
    const user = userEvent.setup();
    render(<AccountLedger {...props} />);
    expect(screen.getAllByText('PAYMENT')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('GIFT')).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });
  it('opens the page containing a linked ledger entry and keeps reversal available', async () => {
    const user = userEvent.setup();
    const reverse = vi.fn();
    render(<AccountLedger {...props} linkedEntryId="id-7" onReverse={reverse} />);
    expect(screen.getByText('GIFT')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: '申请冲正' });
    await user.click(buttons[buttons.length - 1]!);
    expect(reverse).toHaveBeenCalledWith('id-7', 'account');
  });
});
