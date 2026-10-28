import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BasicDataWorkbench } from './basic-data-workbench.js';
import { PreviewDialog } from './structured-workbench.js';

const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
const display = {
  title: '课程交费', summary: '核对交费前后余额',
  beforeBalance: { paidBalance: '120.00', giftBalance: '20.00', totalBalance: '140.00' },
  afterBalance: { paidBalance: '80.00', giftBalance: '20.00', totalBalance: '100.00' },
  accountId: 'account-internal', idempotencyKey: 'idempotency-internal',
};

describe('confirmation display integration', () => {
  it('uses Chinese nested business facts in the structured business confirmation and receipt', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', status: 'PENDING', expiresAt: '2099-10-28T00:00:00.000Z', receipt: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><PreviewDialog preview={{ previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', status: 'PENDING', expiresAt: '2099-10-28T00:00:00.000Z', receipt: null, display, success: '交费已登记', invalidate: [] }} onCancel={() => {}} onConfirm={async () => ({ afterBalance: { paidBalance: '80.00', totalBalance: '100.00' }, receiptId: 'receipt-internal' })} /></QueryClientProvider>);

    const dialog = await screen.findByRole('dialog', { name: '课程交费' });
    expect(within(dialog).getByText('高风险')).toBeInTheDocument();
    expect(within(dialog).getByText('操作前余额')).toBeInTheDocument();
    expect(within(dialog).getByText('操作后余额')).toBeInTheDocument();
    expect(within(dialog).getAllByText('实付余额')).toHaveLength(2);
    expect(within(dialog).getByText('¥120.00')).toBeInTheDocument();
    expect(within(dialog).queryByText(/account-internal|idempotency-internal/)).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: '确认执行' }));
    expect(await within(dialog).findByText('执行回执')).toBeInTheDocument();
    expect(within(dialog).getAllByText('账户总余额').length).toBeGreaterThanOrEqual(3);
    expect(within(dialog).queryByText('receipt-internal')).not.toBeInTheDocument();
  });

  it('uses the same Chinese fact renderer in the teacher and course confirmation dialog', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const basicPreviewId = 'c87af11b-a40f-42cc-92b1-d176c9ad2ea1';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/teachers' || path === '/api/courses') return new Response('[]', { status: 200 });
      if (path === '/api/assistant/previews/structured-action') return new Response(JSON.stringify({ previewId: basicPreviewId, actionType: 'teacher.create', schemaVersion: 'teacher.create.v1', riskLevel: 'L1', expiresAt: '2099-10-28T00:00:00.000Z', display: { title: '新增教师资料', summary: '林老师，基本工资 ¥3200.00', name: '林老师', baseSalary: '3200.00', commissionRate: '8.0000', createsLoginAccount: false, teacherId: 'teacher-internal', requestId: 'request-internal' } }), { status: 201 });
      if (path === `/api/assistant/previews/${basicPreviewId}`) return new Response(JSON.stringify({ previewId: basicPreviewId, actionType: 'teacher.create', schemaVersion: 'teacher.create.v1', riskLevel: 'L1', status: 'PENDING', expiresAt: '2099-10-28T00:00:00.000Z', receipt: null }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><BasicDataWorkbench /></QueryClientProvider>);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '新增教师' }));
    await user.type(screen.getByLabelText('教师姓名'), '林老师');
    await user.clear(screen.getByLabelText('默认基本工资'));
    await user.type(screen.getByLabelText('默认基本工资'), '3200.00');
    await user.clear(screen.getByLabelText('默认提成比例'));
    await user.type(screen.getByLabelText('默认提成比例'), '8.0000');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));

    const dialog = await screen.findByRole('dialog', { name: '新增教师资料' });
    expect(within(dialog).getByText('低风险')).toBeInTheDocument();
    expect(within(dialog).getByText('教师姓名')).toBeInTheDocument();
    expect(within(dialog).getByText('基本工资')).toBeInTheDocument();
    expect(within(dialog).getByText('¥3200.00')).toBeInTheDocument();
    expect(within(dialog).getByText('提成比例')).toBeInTheDocument();
    expect(within(dialog).getByText('不会创建登录账号')).toBeInTheDocument();
    expect(within(dialog).queryByText(/teacher-internal|request-internal/)).not.toBeInTheDocument();
  });
});
