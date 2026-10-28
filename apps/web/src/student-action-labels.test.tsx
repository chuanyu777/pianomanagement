import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StructuredWorkbench } from './structured-workbench.js';

describe('student account action amount labels', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/students') return new Response(JSON.stringify([{ id: 'student-1', name: '小周', phone: null, notes: null, enrollmentStatus: 'ACTIVE', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }]), { status: 200 });
      if (path === '/api/students/student-1/course-accounts') return new Response(JSON.stringify([{ id: 'account-1', courseId: 'course-1', courseName: '钢琴课', defaultDurationMinutes: 60, currentUnitPrice: '100.00', version: 1 }]), { status: 200 });
      if (path === '/api/student-course-accounts/account-1/balance') return new Response(JSON.stringify({ accountId: 'account-1', paidBalance: '100.00', giftBalance: '0.00', totalBalance: '100.00' }), { status: 200 });
      return new Response('[]', { status: 200 });
    }));
  });

  it('labels the entered value according to payment, gift, price-change, or final-refund action', async () => {
    const user = userEvent.setup();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/students']}><StructuredWorkbench section="students" role="OWNER" /></MemoryRouter></QueryClientProvider>);

    await user.click(await screen.findByRole('button', { name: '登记交费' }));
    expect(screen.getByLabelText('交费金额')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /取.*消/ }));

    await user.click(screen.getByRole('button', { name: '登记赠送' }));
    expect(screen.getByLabelText('赠送金额')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /取.*消/ }));

    await user.click(screen.getByRole('button', { name: '修改单价' }));
    expect(screen.getByLabelText('修改后单价')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /取.*消/ }));

    await user.click(screen.getByRole('button', { name: '最终退款' }));
    expect(screen.getByLabelText('退款手续费')).toBeInTheDocument();
  });
});
