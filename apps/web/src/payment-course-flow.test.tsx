import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { StructuredWorkbench } from './structured-workbench.js';

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); });

it('prepares one payment preview for a new course and edited price without opening an account separately', async () => {
  window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/students/page?')) return Response.json({ items: [{ id: 's1', name: '小林', phone: null, notes: null, enrollmentStatus: 'STUDYING', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }], total: 1, page: 1, pageSize: 8 });
    if (path === '/api/students/s1/course-accounts') return Response.json([]);
    if (path === '/api/courses') return Response.json([{ id: 'c1', name: '主课', defaultUnitPrice: '200.00', defaultDurationMinutes: 45, isActive: true }]);
    if (path === '/api/assistant/previews/course-accounts/payment') return Response.json({ previewId: '40000000-0000-4000-8000-000000000004', actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', expiresAt: '2099-10-28T00:00:00Z', display: { title: '缴费确认单' } }, { status: 201 });
    if (path === '/api/assistant/previews/40000000-0000-4000-8000-000000000004') return Response.json({ previewId: '40000000-0000-4000-8000-000000000004', actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', expiresAt: '2099-10-28T00:00:00Z', status: 'PENDING', receipt: null, display: { title: '缴费确认单' } });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><StructuredWorkbench section="students" role="OWNER" /></MemoryRouter></QueryClientProvider>);
  await user.click(await screen.findByRole('button', { name: '登记交费' }));
  expect(screen.queryByRole('button', { name: '开通课程账户' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('combobox', { name: '缴费课程' }));
  await user.click(await screen.findByText('主课'));
  expect(screen.getByLabelText('单节课价格')).toHaveValue('200.00');
  await user.clear(screen.getByLabelText('单节课价格'));
  await user.type(screen.getByLabelText('单节课价格'), '180.50');
  await user.clear(screen.getByLabelText('交费金额'));
  await user.type(screen.getByLabelText('交费金额'), '500.00');
  expect(screen.getByRole('button', { name: '生成确认单' })).toBeDisabled();
  await user.click(screen.getByRole('combobox', { name: '收付款渠道' }));
  await user.click(await screen.findByText('微信'));
  await user.click(screen.getByRole('button', { name: '生成确认单' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === '/api/assistant/previews/course-accounts/payment')).toBe(true));
  const call = fetchMock.mock.calls.find(([path]) => path === '/api/assistant/previews/course-accounts/payment');
  const body = JSON.parse(String(call?.[1]?.body));
  expect(body).toMatchObject({ studentId: 's1', courseId: 'c1', amount: '500.00', currentUnitPrice: '180.50', channel: 'WECHAT' });
  expect(body.idempotencyKey).toBeTruthy(); expect(body.requestId).toBeTruthy(); expect(body.occurredAt).toBeTruthy();
  expect(body).not.toHaveProperty('accountId');
  expect(await screen.findByRole('button', { name: '确认执行' })).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/confirm'))).toBe(false);
  expect(screen.getByText('缴费确认单')).toBeInTheDocument();
});
