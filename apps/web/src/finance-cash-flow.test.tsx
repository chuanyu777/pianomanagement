import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { StructuredWorkbench } from './structured-workbench.js';

const cashFlow = {
  periodType: 'MONTH', period: '2026-10', rangeStart: '2026-09-30T16:00:00.000Z', rangeEnd: '2026-10-31T16:00:00.000Z',
  cashIncome: '160.00', cashExpense: '106.00', cashNet: '54.00',
  items: [
    { id: 'manual-out', type: 'MANUAL_EXPENSE', direction: 'EXPENSE', occurredAt: '2026-10-27T06:00:00.000Z', amount: '12.00', channel: 'CASH', note: '房租', counterparty: null, category: 'RENT_PROPERTY' },
    { id: 'payroll-1', type: 'PAYROLL', direction: 'EXPENSE', occurredAt: '2026-10-27T04:00:00.000Z', amount: '70.00', channel: 'BANK_TRANSFER', note: '十月工资', counterparty: '王老师', category: null },
    { id: 'refund-1', type: 'REFUND', direction: 'EXPENSE', occurredAt: '2026-10-27T03:00:00.000Z', amount: '24.00', channel: 'BANK_TRANSFER', note: null, counterparty: '小周', category: null, feeAmount: '6.00', totalPaidRefund: '30.00' },
    { id: 'payment-1', type: 'PAYMENT', direction: 'INCOME', occurredAt: '2026-10-27T01:00:00.000Z', amount: '150.00', channel: 'CASH', note: null, counterparty: '小雨 · 钢琴课', category: null },
    { id: 'manual-in', type: 'MANUAL_INCOME', direction: 'INCOME', occurredAt: '2026-10-26T01:00:00.000Z', amount: '10.00', channel: 'CASH', note: null, counterparty: null, category: 'BOOK_SALE' },
  ],
};

function renderFinance(path = '/finance?tab=manual&period=2026-10') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><StructuredWorkbench section="finance" role="OWNER" /></MemoryRouter></QueryClientProvider>);
}

describe('finance cash flow UI', () => {
  it('shows real aggregated cash rows from all sources, backend totals, and filters by record type', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith('/api/reports/cash-flow?')) return new Response(JSON.stringify(cashFlow), { status: 200 });
      if (path.startsWith('/api/manual-transactions?')) return new Response('[]', { status: 200 });
      if (path.startsWith('/api/reports/monthly?')) return new Response(JSON.stringify({ periodStart: '2026-10-01T00:00:00.000Z', cashIncome: '150.00', cashExpense: '106.00', cashNet: '44.00', lessonIncome: '0.00', refundFeeIncome: '0.00', manualIncome: '0.00', payrollCost: '0.00', giftCost: '0.00', manualExpense: '0.00', operatingProfit: '0.00' }), { status: 200 });
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderFinance();

    const table = await screen.findByRole('table', { name: '现金流水列表' });
    expect(within(table).getByText('小雨 · 钢琴课')).toBeInTheDocument();
    expect(within(table).getByText('王老师')).toBeInTheDocument();
    expect(within(table).getByText('小周')).toBeInTheDocument();
    expect(within(table).getByText('房租')).toBeInTheDocument();
    expect(screen.getAllByText('¥150.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('¥106.00')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/reports/cash-flow?period=2026-10')).toBe(true);

    await user.click(screen.getByRole('combobox', { name: '现金流水类型筛选' }));
    await user.click(await screen.findByText('学生退款', { selector: '.ant-select-item-option-content' }));
    expect(within(table).getByText('小周')).toBeInTheDocument();
    expect(within(table).queryByText('王老师')).not.toBeInTheDocument();
    expect(within(table).queryByText('小雨 · 钢琴课')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('报表月份'), { target: { value: '2026-11' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/reports/cash-flow?period=2026-11')).toBe(true));
  });

  it('keeps the manual transaction form and its preview-based registration available', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith('/api/reports/cash-flow?')) return new Response(JSON.stringify({ ...cashFlow, items: [] }), { status: 200 });
      if (path.startsWith('/api/manual-transactions?')) return new Response('[]', { status: 200 });
      if (path.startsWith('/api/reports/monthly?')) return new Response(JSON.stringify({ periodStart: '2026-10-01T00:00:00.000Z', cashIncome: '0.00', cashExpense: '0.00', cashNet: '0.00', lessonIncome: '0.00', refundFeeIncome: '0.00', manualIncome: '0.00', payrollCost: '0.00', giftCost: '0.00', manualExpense: '0.00', operatingProfit: '0.00' }), { status: 200 });
      if (path === '/api/assistant/previews/structured-action') return new Response(JSON.stringify({ previewId: 'c87af11b-a40f-42cc-92b1-d176c9ad2ea1', actionType: 'manual-transaction.create', schemaVersion: 'manual-transaction.create.v1', riskLevel: 'L1', expiresAt: '2099-10-28T00:00:00.000Z', display: { title: '登记手工收支' } }), { status: 201 });
      if (path === '/api/assistant/previews/c87af11b-a40f-42cc-92b1-d176c9ad2ea1') return new Response(JSON.stringify({ previewId: 'c87af11b-a40f-42cc-92b1-d176c9ad2ea1', actionType: 'manual-transaction.create', schemaVersion: 'manual-transaction.create.v1', riskLevel: 'L1', status: 'PENDING', expiresAt: '2099-10-28T00:00:00.000Z', receipt: null }), { status: 200 });
      if (path === '/api/assistant/previews/c87af11b-a40f-42cc-92b1-d176c9ad2ea1/confirm') return new Response(JSON.stringify({ previewId: 'c87af11b-a40f-42cc-92b1-d176c9ad2ea1', status: 'EXECUTED', receipt: { manualTransactionId: 'manual-1' } }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderFinance();

    expect(await screen.findByRole('button', { name: '登记收支' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '收支类型' })).toBeInTheDocument();
    expect(screen.getByLabelText('金额')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('金额'));
    await user.type(screen.getByLabelText('金额'), '5.00');
    await user.click(screen.getByRole('button', { name: '登记收支' }));
    await screen.findByRole('button', { name: '确认执行' });
    const previewCall = fetchMock.mock.calls.find(([path]) => String(path) === '/api/assistant/previews/structured-action');
    expect(JSON.parse(String(previewCall?.[1]?.body))).toMatchObject({ actionType: 'manual-transaction.create', command: { amount: '5.00', kind: 'INCOME', incomeCategory: 'BOOK_SALE' } });
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    await screen.findByText('执行回执');
    expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/assistant/previews/c87af11b-a40f-42cc-92b1-d176c9ad2ea1/confirm')).toBe(true);
  });
});
