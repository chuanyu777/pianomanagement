import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StructuredWorkbench } from './structured-workbench.js';

const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
const pending = (actionType: string) => ({ previewId, actionType, schemaVersion: `${actionType}.v1`, riskLevel: 'L2', status: 'PENDING', expiresAt: '2099-10-28T00:00:00.000Z', receipt: null });

function renderWorkbench(section: 'finance' | 'students', path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><StructuredWorkbench section={section} role="OWNER" /></MemoryRouter></QueryClientProvider>);
}

describe('critical finance workflows', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
  });

  it('previews and confirms payroll payment, then refreshes the payroll and cash-flow views', async () => {
    const user = userEvent.setup();
    let paid = false;
    let cashFlowReads = 0;
    const payroll = () => ({ id: 'payroll-1', teacherId: 'teacher-1', teacherName: '王老师', periodStart: '2026-10-01T00:00:00.000Z', courseRevenue: '100.00', baseSalary: '0.00', commissionRate: '10.00', commissionAmount: '10.00', bonusAmount: '0.00', deductionAmount: '0.00', grossSalary: '10.00', netSalary: '10.00', status: paid ? 'PAID' : 'UNPAID', paidAt: paid ? '2026-10-28T01:00:00.000Z' : null, paymentChannel: paid ? 'CASH' : null, version: paid ? 2 : 1 });
    const cashFlow = () => {
      cashFlowReads += 1;
      return { periodType: 'MONTH', period: '2026-10', rangeStart: '2026-09-30T16:00:00.000Z', rangeEnd: '2026-10-31T16:00:00.000Z', cashIncome: '0.00', cashExpense: paid ? '10.00' : '0.00', cashNet: paid ? '-10.00' : '0.00', items: paid ? [{ id: 'payroll-1', type: 'PAYROLL', direction: 'EXPENSE', occurredAt: '2026-10-28T01:00:00.000Z', amount: '10.00', channel: 'CASH', note: null, counterparty: '王老师', category: null }] : [] };
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith('/api/payrolls?')) return new Response(JSON.stringify([payroll()]), { status: 200 });
      if (path.startsWith('/api/teachers')) return new Response(JSON.stringify([{ id: 'teacher-1', name: '王老师', isActive: true }]), { status: 200 });
      if (path.startsWith('/api/reports/cash-flow?')) return new Response(JSON.stringify(cashFlow()), { status: 200 });
      if (path.startsWith('/api/manual-transactions?')) return new Response('[]', { status: 200 });
      if (path.startsWith('/api/reports/monthly?')) return new Response(JSON.stringify({ periodStart: '2026-10-01T00:00:00.000Z', cashIncome: '0.00', cashExpense: '0.00', cashNet: '0.00', lessonIncome: '0.00', refundFeeIncome: '0.00', manualIncome: '0.00', payrollCost: '0.00', giftCost: '0.00', manualExpense: '0.00', operatingProfit: '0.00' }), { status: 200 });
      if (path === '/api/assistant/previews/structured-action') return new Response(JSON.stringify({ ...pending('payroll.pay'), status: undefined, display: { title: '确认工资支付', summary: '王老师：¥10.00' } }), { status: 201 });
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(pending('payroll.pay')), { status: 200 });
      if (path === `/api/assistant/previews/${previewId}/confirm` && init?.method === 'POST') {
        paid = true;
        return new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: { payrollId: 'payroll-1', amount: '10.00' } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWorkbench('finance', '/finance?tab=manual&period=2026-10');

    await screen.findByRole('table', { name: '现金流水列表' });
    await user.click(screen.getByRole('tab', { name: '工资' }));
    await user.click(await screen.findByRole('button', { name: '登记支付' }));
    await user.click(await screen.findByRole('button', { name: '确认支付登记' }));
    await user.click(await screen.findByRole('button', { name: '确认执行' }));
    expect(await screen.findByText('执行回执')).toBeInTheDocument();
    const payrollTable = await screen.findByRole('table', { name: '工资列表' });
    await waitFor(() => expect(within(payrollTable).getByText('已支付')).toBeInTheDocument());

    await user.click(screen.getByRole('tab', { name: '手工收支' }));
    await waitFor(() => expect(cashFlowReads).toBeGreaterThan(1));
    expect(await screen.findByText('王老师')).toBeInTheDocument();
    expect(screen.getAllByText('¥10.00').length).toBeGreaterThan(0);
  }, 15000);

  it('blocks month-close preview while Core readiness reports blockers', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/periods') return new Response('[]', { status: 200 });
      if (path.startsWith('/api/periods/preclose?')) return new Response(JSON.stringify({ period: '2026-10', closed: false, blockers: [{ code: 'UNPAID_PAYROLL', count: 1, message: '存在未支付工资' }], pendingLessons: [], missingPayrollTeachers: [], unpaidPayrolls: [{ payrollId: 'p1', teacherId: 't1', teacherName: '王老师', netSalary: '10.00' }], refundAnomalies: [], ledgerAnomalies: [] }), { status: 200 });
      if (path.startsWith('/api/reports/monthly?')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWorkbench('finance', '/finance?tab=periods&period=2026-10');

    expect(await screen.findByText('存在未支付工资')).toBeInTheDocument();
    await screen.findByText('检查并关账：2026-10');
    const closeAction = screen.getByText('检查并关账：2026-10').closest('form')?.querySelector('button');
    expect(closeAction).not.toBeNull();
    expect(closeAction).toBeDisabled();
    expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/assistant/previews/structured-action')).toBe(false);
  });

  it('creates and confirms a month-close preview only after readiness passes, then refreshes closed periods', async () => {
    const user = userEvent.setup();
    let closed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/periods') return new Response(JSON.stringify(closed ? [{ period: '2026-10', closedAt: '2026-10-28T01:00:00.000Z', reopenedAt: null, reopenReason: null }] : []), { status: 200 });
      if (path.startsWith('/api/periods/preclose?')) return new Response(JSON.stringify({ period: '2026-10', closed, blockers: [], pendingLessons: [], missingPayrollTeachers: [], unpaidPayrolls: [], refundAnomalies: [], ledgerAnomalies: [] }), { status: 200 });
      if (path.startsWith('/api/reports/monthly?')) return new Response('{}', { status: 200 });
      if (path === '/api/assistant/previews/structured-action') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ actionType: 'period.close', command: { period: '2026-10' } });
        return new Response(JSON.stringify({ ...pending('period.close'), display: { title: '确认关账', summary: '2026-10' } }), { status: 201 });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(pending('period.close')), { status: 200 });
      if (path === `/api/assistant/previews/${previewId}/confirm` && init?.method === 'POST') {
        closed = true;
        return new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: { period: '2026-10' } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWorkbench('finance', '/finance?tab=periods&period=2026-10');

    const closeAction = await screen.findByText('检查并关账：2026-10');
    await user.click(closeAction.closest('form')!.querySelector('button')!);
    await user.click(await screen.findByRole('button', { name: '确认执行' }));
    expect(await screen.findByText('执行回执')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/periods')).toBe(true));
    expect(await screen.findByRole('table', { name: '关账列表' })).toHaveTextContent('2026-10');
    expect(fetchMock.mock.calls.some(([path, request]) => String(path).endsWith(`/previews/${previewId}/confirm`) && request?.method === 'POST')).toBe(true);
  });

  it('previews and confirms a manual expense, then refreshes both the record list and cash totals', async () => {
    const user = userEvent.setup();
    let created = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith('/api/manual-transactions?')) return new Response(JSON.stringify(created ? [{ id: 'manual-expense-1', kind: 'EXPENSE', incomeCategory: null, expenseCategory: 'RENT_PROPERTY', amount: '25.00', channel: 'CASH', occurredAt: '2026-10-28T01:00:00.000Z', note: '房租', createdAt: '2026-10-28T01:00:00.000Z' }] : []), { status: 200 });
      if (path.startsWith('/api/reports/cash-flow?')) return new Response(JSON.stringify({ periodType: 'MONTH', period: '2026-10', rangeStart: '2026-09-30T16:00:00.000Z', rangeEnd: '2026-10-31T16:00:00.000Z', cashIncome: '0.00', cashExpense: created ? '25.00' : '0.00', cashNet: created ? '-25.00' : '0.00', items: created ? [{ id: 'manual-expense-1', type: 'MANUAL_EXPENSE', direction: 'EXPENSE', occurredAt: '2026-10-28T01:00:00.000Z', amount: '25.00', channel: 'CASH', note: '房租', counterparty: null, category: 'RENT_PROPERTY' }] : [] }), { status: 200 });
      if (path.startsWith('/api/reports/monthly?')) return new Response(JSON.stringify({ periodStart: '2026-10-01T00:00:00.000Z', cashIncome: '0.00', cashExpense: '0.00', cashNet: '0.00', lessonIncome: '0.00', refundFeeIncome: '0.00', manualIncome: '0.00', payrollCost: '0.00', giftCost: '0.00', manualExpense: '0.00', operatingProfit: '0.00' }), { status: 200 });
      if (path === '/api/assistant/previews/structured-action') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ actionType: 'manual-transaction.create', command: { kind: 'EXPENSE', expenseCategory: 'RENT_PROPERTY', amount: '25.00', note: '房租' } });
        return new Response(JSON.stringify({ ...pending('manual-transaction.create'), display: { title: '确认登记支出', summary: '房租 ¥25.00' } }), { status: 201 });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(pending('manual-transaction.create')), { status: 200 });
      if (path === `/api/assistant/previews/${previewId}/confirm` && init?.method === 'POST') {
        created = true;
        return new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: { manualTransactionId: 'manual-expense-1' } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWorkbench('finance', '/finance?tab=manual&period=2026-10');

    await screen.findByRole('table', { name: '现金流水列表' });
    await user.click(screen.getByRole('combobox', { name: '收支类型' }));
    await user.click(await screen.findByText('支出', { selector: '.ant-select-item-option-content' }));
    await user.clear(screen.getByLabelText('金额'));
    await user.type(screen.getByLabelText('金额'), '25.00');
    await user.type(screen.getByLabelText('备注'), '房租');
    await user.click(screen.getByRole('button', { name: '登记收支' }));
    await user.click(await screen.findByRole('button', { name: '确认执行' }));

    expect(await screen.findByText('执行回执')).toBeInTheDocument();
    const transactionTable = await screen.findByRole('table', { name: '手工收支列表' });
    expect(await within(transactionTable).findByText('房租')).toBeInTheDocument();
    expect(within(transactionTable).getByText('支出')).toBeInTheDocument();
    const cashFlowTable = await screen.findByRole('table', { name: '现金流水列表' });
    expect(await within(cashFlowTable).findByText('房租')).toBeInTheDocument();
    expect(screen.getAllByText('¥25.00').length).toBeGreaterThan(0);
  });

  it('sends final refund through a preview and displays the Core receipt after confirmation', async () => {
    const user = userEvent.setup();
    let refunded = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/students') return new Response(JSON.stringify([{ id: 'student-1', name: '小周', phone: null, notes: null, enrollmentStatus: refunded ? 'WITHDRAWN' : 'ACTIVE', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }]), { status: 200 });
      if (path === '/api/students/student-1/course-accounts') return new Response(JSON.stringify([{ id: 'account-1', courseId: 'course-1', courseName: '钢琴课', defaultDurationMinutes: 60, currentUnitPrice: '100.00', version: 1 }]), { status: 200 });
      if (path === '/api/student-course-accounts/account-1/balance') return new Response(JSON.stringify({ accountId: 'account-1', paidBalance: '100.00', giftBalance: '0.00', totalBalance: '100.00' }), { status: 200 });
      if (path === '/api/assistant/previews/students/final-refund' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body));
        expect(request).toMatchObject({ studentId: 'student-1', feeAmount: '0.00' });
        return new Response(JSON.stringify({ ...pending('student.final-refund'), display: { title: '确认最终退款', summary: '小周' } }), { status: 201 });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(pending('student.final-refund')), { status: 200 });
      if (path === `/api/assistant/previews/${previewId}/confirm` && init?.method === 'POST') {
        refunded = true;
        return new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: { refundId: 'refund-1', actualRefundAmount: '100.00' } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWorkbench('students', '/students');

    await screen.findByRole('button', { name: /小周/ });
    await screen.findByRole('button', { name: '登记交费' });
    await user.click(screen.getByRole('button', { name: '最终退款' }));
    await user.clear(screen.getByLabelText('退款手续费'));
    await user.type(screen.getByLabelText('退款手续费'), '0.00');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));
    await user.click(await screen.findByRole('button', { name: '确认执行' }));
    expect(await screen.findByText('执行回执')).toBeInTheDocument();
    expect(screen.getAllByText('¥100.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('refund-1')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('退学')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([path, request]) => String(path).endsWith(`/previews/${previewId}/confirm`) && request?.method === 'POST')).toBe(true);
  });
});
