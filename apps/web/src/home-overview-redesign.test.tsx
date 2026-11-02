import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

const lessons = Array.from({ length: 5 }, (_, index) => ({
  id: `lesson-${index + 1}`, startsAt: '2026-10-28T01:00:00.000Z', endsAt: '2026-10-28T02:00:00.000Z', status: 'SCHEDULED',
  student: { id: `student-${index + 1}`, name: `排课学生${index + 1}` }, course: { id: 'course-1', name: '钢琴课' },
}));
const records = Array.from({ length: 5 }, (_, index) => ({
  id: `record-${index + 1}`, kind: 'PAYMENT', occurredAt: '2026-10-28T01:00:00.000Z',
  studentName: `流水学生${index + 1}`, courseName: '钢琴课', paidDelta: '123.45', giftDelta: '0.00',
}));
const ownerOverview = {
  asOf: '2026-10-28T03:00:00.000Z', businessDate: '2026-10-28',
  today: { total: 5, pendingCount: 2, completedCount: 1, lessons },
  students: { total: 30, frozenCount: 7, arrearsCount: 3 },
  finance: { period: '2026-10', operatingProfit: '9876.54', cashNet: '3456.78' },
  preclose: { period: '2026-10', closed: false, unpaidPayrollCount: 4, blockers: [] },
  recentRecords: records,
};

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

async function setup(role: 'OWNER' | 'TEACHER' = 'OWNER') {
  window.localStorage.setItem('pianomanager.accessToken', 'test-token');
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/auth/me') return Response.json({ id: 'user-1', username: role === 'OWNER' ? 'owner' : 'teacher', role, ...(role === 'TEACHER' ? { teacherId: 'teacher-1' } : {}) });
    if (path === '/api/dashboard/overview') return Response.json(role === 'OWNER' ? ownerOverview : {
      ...ownerOverview, students: null, finance: null, preclose: null, recentRecords: null,
    });
    if (path === '/api/assistant/tasks') return Response.json([]);
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><App /><Location /></MemoryRouter></QueryClientProvider>);
  await screen.findByText('排课学生1 · 钢琴课');
  return { user: userEvent.setup(), fetchMock };
}

describe('首页经营概览改造', () => {
  beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });

  it('不展示冻结学生指标，即使接口返回冻结人数', async () => {
    await setup();
    const overview = screen.getByRole('region', { name: '经营概览' });
    expect(within(overview).queryByText('冻结学生')).not.toBeInTheDocument();
  });

  it('今日排课最多展示三条', async () => {
    await setup();
    const panel = screen.getByRole('region', { name: '今日排课' });
    expect(within(panel).getAllByRole('link', { name: /的排课/ })).toHaveLength(3);
    expect(within(panel).getByText('排课学生3 · 钢琴课')).toBeInTheDocument();
    expect(within(panel).queryByText('排课学生4 · 钢琴课')).not.toBeInTheDocument();
  });

  it('最近账户流水最多展示三条', async () => {
    await setup();
    const heading = screen.getByRole('heading', { name: '最近账户流水' });
    const panel = heading.closest('section');
    expect(panel).not.toBeNull();
    const activity = within(panel as HTMLElement);
    expect(activity.getAllByRole('link', { name: /的账户/ })).toHaveLength(3);
    expect(activity.getByText('流水学生3 · 钢琴课')).toBeInTheDocument();
    expect(activity.queryByText('流水学生4 · 钢琴课')).not.toBeInTheDocument();
  });

  it.each([
    ['进入排课', '/schedule'],
    ['查看账户', '/students'],
  ])('点击%s入口进入对应业务页面', async (label, destination) => {
    const { user } = await setup();
    const overview = screen.getByRole('region', { name: '经营概览' });
    await user.click(within(overview).getByRole('button', { name: new RegExp(label) }));
    expect(screen.getByTestId('location').textContent).toBe(destination);
  });

  it.each([
    ['待确认课消', '/schedule'],
    ['本月经营利润', '/finance'],
    ['关账状态', '/finance?tab=periods'],
  ])('店主可以点击%s指标进入对应业务页面', async (label, destination) => {
    const { user } = await setup();
    const overview = screen.getByRole('region', { name: '经营概览' });
    await user.click(within(overview).getByRole('button', { name: new RegExp(label) }));
    expect(screen.getByTestId('location').textContent).toBe(destination);
  });

  it('教师仅能访问自己的排课入口，首页不显示店主敏感数据或操作', async () => {
    const { user, fetchMock } = await setup('TEACHER');
    const overview = screen.getByRole('region', { name: '经营概览' });
    expect(within(overview).queryByText('¥9876.54')).not.toBeInTheDocument();
    expect(within(overview).queryByText('最近账户流水')).not.toBeInTheDocument();
    expect(within(overview).queryByText('待支付工资')).not.toBeInTheDocument();
    expect(within(overview).queryByRole('button', { name: /本月经营利润|关账状态|学生与账户|收支与报表/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/reports'))).toBe(false);
    await user.click(within(overview).getByRole('button', { name: /待确认课消/ }));
    expect(screen.getByTestId('location').textContent).toBe('/schedule');
  });
});
