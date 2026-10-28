import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

function renderApp(path = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function previewState(previewId: string, status: 'PENDING' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED' | 'STALE' = 'PENDING', receipt: Record<string, unknown> | null = null, expiresAt = '2099-10-21T02:00:00.000Z') {
  return { previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', status, expiresAt, receipt };
}

describe('AI workspace', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Agent Runtime unavailable')));
  });

  it('clears the shared query cache and scopes home queries when switching from owner to teacher', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const ownerTaskTitle = '仅店主可见的历史任务';
    const ownerStudentName = '仅店主可见的学生';
    let currentRole: 'OWNER' | 'TEACHER' = 'OWNER';
    const overview = (role: 'OWNER' | 'TEACHER') => ({
      asOf: '2026-10-28T00:00:00.000Z', businessDate: '2026-10-28',
      today: { total: role === 'OWNER' ? 1 : 0, pendingCount: 0, completedCount: 0, lessons: role === 'OWNER' ? [{ id: 'owner-lesson', startsAt: '2026-10-28T01:00:00.000Z', endsAt: '2026-10-28T02:00:00.000Z', status: 'SCHEDULED', student: { id: 'owner-student', name: ownerStudentName }, course: { id: 'owner-course', name: '店主课程' } }] : [] },
      students: role === 'OWNER' ? { total: 1, frozenCount: 0, arrearsCount: 0 } : null,
      finance: role === 'OWNER' ? { period: '2026-10', operatingProfit: '800.00', cashNet: '800.00' } : null,
      preclose: role === 'OWNER' ? { period: '2026-10', closed: false, unpaidPayrollCount: 0, blockers: [] } : null,
      recentRecords: null,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'shared-user', username: currentRole === 'OWNER' ? 'owner' : 'teacher', role: currentRole, ...(currentRole === 'TEACHER' ? { teacherId: 'teacher-identity' } : {}) }));
      if (path === '/api/auth/login') {
        currentRole = 'TEACHER';
        return new Response(JSON.stringify({ accessToken: 'teacher-token', user: { id: 'teacher-user', username: 'teacher', role: 'TEACHER', teacherId: 'teacher-identity' } }));
      }
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-28T00:00:00.000Z', message: '助手暂不可用' }));
      if (path === '/api/dashboard/overview') return new Response(JSON.stringify(overview(currentRole)));
      if (path === '/api/assistant/tasks') return new Response(JSON.stringify(currentRole === 'OWNER' ? [{ threadId: '10000000-0000-4000-8000-000000000001', title: ownerTaskTitle, lastActivityAt: '2026-10-28T00:00:00.000Z', latestStatus: 'completed' }] : []));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.setItem('pianomanager.accessToken', 'owner-token');
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/']}><App /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText(ownerTaskTitle)).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: ['home-overview'] }).some((query) => query.state.data !== undefined)).toBe(true));
    expect(queryClient.getQueryCache().findAll({ queryKey: ['home-overview'] })[0]?.state.data).toMatchObject({ today: { lessons: [{ student: { name: ownerStudentName } }] } });
    queryClient.setQueryData(['structured-lessons', 'owner-week'], [{ student: { name: ownerStudentName } }]);
    await user.click(screen.getByRole('button', { name: '退出登录' }));

    expect(await screen.findByRole('heading', { name: '登录工作台' })).toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(['structured-lessons', 'owner-week'])).toBeUndefined();
    await user.type(screen.getByLabelText('用户名'), 'teacher');
    await user.type(screen.getByLabelText('密码'), 'teacher-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));

    expect(await screen.findByText('teacher')).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryData(['assistant-tasks', 'teacher-user', 'TEACHER', 'teacher-identity'])).toEqual([]));
    expect(screen.queryByText(ownerTaskTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(ownerStudentName)).not.toBeInTheDocument();
    expect(queryClient.getQueryCache().find({ queryKey: ['home-overview', 'teacher-user', 'TEACHER', 'teacher-identity'] })).toBeDefined();
  });

  it('clears cached business data when login succeeds', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['structured-lessons', '2026-10-28'], [{ student: { name: 'private cached lesson' } }]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'next-token', user: { id: 'next-user', username: 'owner', role: 'OWNER' } }));
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-28T00:00:00.000Z', message: '助手暂不可用' }));
      if (path === '/api/dashboard/overview') return new Response(JSON.stringify({ asOf: '2026-10-28T00:00:00.000Z', businessDate: '2026-10-28', today: { total: 0, pendingCount: 0, completedCount: 0, lessons: [] }, students: null, finance: null, preclose: null, recentRecords: null }));
      if (path === '/api/assistant/tasks') return new Response('[]');
      return new Response('{}', { status: 404 });
    }));
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/']}><App /></MemoryRouter></QueryClientProvider>);
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await screen.findByText('owner');
    expect(queryClient.getQueryData(['structured-lessons', '2026-10-28'])).toBeUndefined();
  });

  it('clears cached business data when stored-token authentication fails', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['structured-lessons', '2026-10-28'], [{ student: { name: 'private cached lesson' } }]);
    window.localStorage.setItem('pianomanager.accessToken', 'expired-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })));
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/']}><App /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: '登录工作台' })).toBeInTheDocument();
    expect(queryClient.getQueryData(['structured-lessons', '2026-10-28'])).toBeUndefined();
  });

  it('requires login before showing authenticated pages', () => {
    renderApp();

    expect(screen.getByRole('heading', { name: '登录工作台' })).toBeInTheDocument();
    expect(screen.getByLabelText('用户名')).toBeInTheDocument();
  });

  it('allows an owner to open a course account for a student without one', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const student = { id: 's1', name: '测试学生', phone: null, notes: null, enrollmentStatus: 'STUDYING', createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' };
    const accountPreviewId = '1f1d4de6-36cb-4ec2-904d-c522927d8d0c';
    const accountPreview = { previewId: accountPreviewId, actionType: 'course-account.open', schemaVersion: 'course-account.open.v1', riskLevel: 'L2', expiresAt: '2099-10-28T00:00:00.000Z', display: { title: '开通课程账户' } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }));
      if (path === '/api/students') return new Response(JSON.stringify([student]));
      if (path === '/api/courses') return new Response(JSON.stringify([{ id: 'c1', name: '主课', defaultUnitPrice: '200.00', defaultDurationMinutes: 45, isActive: true }]));
      if (path.includes('/course-accounts')) return new Response('[]');
      if (path === '/api/assistant/previews/structured-action') return new Response(JSON.stringify(accountPreview), { status: 201 });
      if (path === `/api/assistant/previews/${accountPreviewId}`) return new Response(JSON.stringify({ ...accountPreview, status: 'PENDING', receipt: null }));
      if (path === `/api/assistant/previews/${accountPreviewId}/confirm` && init?.method === 'POST') return new Response(JSON.stringify({ previewId: accountPreviewId, status: 'EXECUTED', receipt: { accountId: 'a1' } }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp('/students');
    await user.click(await screen.findByRole('button', { name: '开通课程账户' }, { timeout: 5000 }));
    expect(await screen.findByRole('combobox', { name: '选择课程' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: '选择课程' }));
    await user.click(await screen.findByText('主课 · 默认 ¥200.00'));
    await user.click(screen.getByRole('button', { name: '生成确认单' }));
    await user.click(await screen.findByRole('button', { name: '确认执行' }));
    expect(await screen.findByText('执行回执')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => path === '/api/students').length).toBeGreaterThanOrEqual(2));
    const call = fetchMock.mock.calls.find(([path]) => path === '/api/assistant/previews/structured-action');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ actionType: 'course-account.open', command: { studentId: 's1', courseId: 'c1' } });
  }, 15000);

  it('uses the approved AI operating-center shell on authenticated pages', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/me') return Promise.resolve(new Response(JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }), { status: 200 }));
      if (path === '/api/assistant/status') return Promise.resolve(new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-27T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 }));
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));

    renderApp();

    expect(await screen.findByText('AI NATIVE · 经营工作台')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /今日中枢.*AI 协同入口/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /学生与账户.*学生与资金/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /排课与课消.*周视图与课消/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /收支与报表.*经营与现金/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '今天先处理什么？' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '经营工作区' })).toBeInTheDocument();
  });

  it('logs in, saves the JWT, and uses it to load the live student list', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return Promise.resolve(new Response(JSON.stringify({ accessToken: 'jwt-test', tokenType: 'Bearer', expiresInSeconds: 3600, user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 }));
      if (path === '/api/assistant/status') return Promise.resolve(new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手已连接' }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify([{ id: 's1', name: '真实学生', phone: null, notes: null, enrollmentStatus: 'STUDYING', createdAt: '2026-10-16T01:02:03.000Z', updatedAt: '2026-10-16T01:02:03.000Z' }]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp('/structured/students');
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));

    expect((await screen.findAllByText('真实学生')).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('pianomanager.accessToken')).toBe('jwt-test');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/login');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ username: 'owner', password: 'correct-password' });
    const studentsCall = fetchMock.mock.calls.find(([path]) => path === '/api/students');
    expect(new Headers(studentsCall?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    expect(screen.getByText('学生档案与课程账户')).toBeInTheDocument();
  });

  it('loads real schedule records with their related student and course', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const body = String(input) === '/api/auth/me'
        ? { id: 'u1', username: 'owner', role: 'OWNER' }
        : String(input) === '/api/assistant/status'
        ? { available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手暂不可用' }
        : [{ id: 'l1', accountId: 'a1', teacherId: 't1', startsAt: `${today}T10:00:00+08:00`, endsAt: `${today}T11:00:00+08:00`, status: 'SCHEDULED', student: { id: 's1', name: '真实学生' }, course: { id: 'c1', name: '钢琴课' }, unitPriceSnapshot: null }];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    renderApp('/structured/schedule');
    expect(await screen.findByText('钢琴课')).toBeInTheDocument();
    expect(screen.getByText('真实学生')).toBeInTheDocument();
  });

  it('returns to login when a stored token is rejected by Core API', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'expired-jwt');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/assistant/status') return Promise.resolve(new Response(JSON.stringify({ available: false, core: { available: false }, agentRuntime: { available: false }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手暂不可用' }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }));
    }));

    renderApp('/structured/students');

    expect(await screen.findByRole('heading', { name: '登录工作台' })).toBeInTheDocument();
    expect(window.localStorage.getItem('pianomanager.accessToken')).toBeNull();
  });

  it('verifies the current actor before restoring a role- and teacher-scoped conversation', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    window.sessionStorage.setItem('pianomanager.assistant.actor', JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }));
    window.sessionStorage.setItem('pianomanager.assistant.session.v1:u1', JSON.stringify({
      threadId: '4f229d18-5a0f-4ec2-904d-c522927d8d0c',
      messages: [{ id: 'message-1', role: 'user', text: '旧财务历史' }],
      workspace: { protocolVersion: '1.0', title: '旧财务工作区', blocks: [{ type: 'summary', title: '旧财务历史', text: '不应展示' }], sources: [] },
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'u1', username: 'teacher', role: 'TEACHER', teacherId: 'teacher-2' }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-21T02:00:00.000Z', message: 'AI 助手暂不可用' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    await waitFor(() => expect(screen.getByText('teacher')).toBeInTheDocument());
    expect(screen.queryByText('旧财务工作区')).not.toBeInTheDocument();
    expect(screen.queryByText('旧财务历史')).not.toBeInTheDocument();
    const meCall = fetchMock.mock.calls.find(([path]) => path === '/api/auth/me');
    expect(new Headers(meCall?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
  });

  it('does not label an AI reply as a completed business action in recent tasks', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }));
      if (path === '/api/assistant/tasks') return new Response(JSON.stringify([{ threadId: '9eb3b8c3-b730-4e49-baa0-0b4de36b9345', title: '待确认的登记', lastActivityAt: '2026-10-28T00:00:00Z', latestStatus: 'completed' }]));
      return new Response('{}', { status: 404 });
    }));
    renderApp('/');
    const taskButton = await screen.findByRole('button', { name: /待确认的登记/ });
    expect(taskButton).toHaveTextContent('已回复');
    expect(taskButton).not.toHaveTextContent('已完成');
  });

  it('offers teachers only relevant suggested questions on the home page', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/auth/me'
      ? new Response(JSON.stringify({ id: 'u1', username: 'teacher', role: 'TEACHER', teacherId: 't1' }))
      : new Response('{}', { status: 404 })));
    renderApp('/');
    expect(await screen.findByRole('button', { name: '查看今日排课' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看这个月收入' })).not.toBeInTheDocument();
    expect(screen.queryByText(/办理学生账户和日常经营事项/)).not.toBeInTheDocument();
  });

  it('hides owner-only navigation and blocks direct owner routes for teachers', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/me') return Promise.resolve(new Response(JSON.stringify({ id: 'u1', username: 'teacher', role: 'TEACHER', teacherId: 't1' }), { status: 200 }));
      if (path === '/api/assistant/status') return Promise.resolve(new Response(JSON.stringify({ available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-26T02:00:00.000Z', message: 'AI 助手暂不可用' }), { status: 200 }));
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp('/structured/finance');

    expect(await screen.findByText('当前账号无权访问该页面')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /学生与账户/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /收支与报表/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith('/api/reports/'))).toBe(false);
  });

  it('loads and displays monthly report values from Core API', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const report = { periodStart: '2026-10-01T00:00:00.000Z', cashIncome: '1200.00', cashExpense: '300.00', cashNet: '900.00', lessonIncome: '800.00', refundFeeIncome: '0.00', manualIncome: '400.00', payrollCost: '100.00', giftCost: '50.00', manualExpense: '200.00', operatingProfit: '850.00' };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const body = String(input) === '/api/auth/me'
        ? { id: 'u1', username: 'owner', role: 'OWNER' }
        : String(input) === '/api/assistant/status'
        ? { available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手暂不可用' }
        : report;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    renderApp('/structured/finance');
    expect(await screen.findByText('¥1200.00')).toBeInTheDocument();
    expect(screen.getByText('经营利润')).toBeInTheDocument();
  });

  it('requires a reason and requests a Core preview before cancelling a payroll payment', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const payroll = { id: 'p1', teacherId: 't1', teacherName: '王老师', periodStart: '2026-10-01T00:00:00Z', courseRevenue: '100.00', baseSalary: '0.00', commissionRate: '10.00', commissionAmount: '10.00', bonusAmount: '0.00', deductionAmount: '0.00', grossSalary: '10.00', netSalary: '10.00', status: 'PAID', paidAt: '2026-10-20T00:00:00Z', paymentChannel: 'CASH', version: 1 };
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      const body = path === '/api/auth/me' ? { id: 'u1', username: 'owner', role: 'OWNER' }
        : path.startsWith('/api/payrolls?') ? [payroll] : path === '/api/teachers' ? [] : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp('/finance?tab=payroll&period=2026-10');
    await user.click(await screen.findByRole('button', { name: '撤销支付' }));
    expect(screen.getByRole('button', { name: '生成确认单' })).toBeDisabled();
    await user.type(screen.getByLabelText('撤销工资支付原因'), '支付信息有误');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/previews/structured-action'))).toBe(true));
    const previewCall = fetchMock.mock.calls.find(([path]) => String(path).includes('/previews/structured-action'));
    expect(JSON.parse(String(previewCall?.[1]?.body))).toMatchObject({ actionType: 'payroll.cancel-payment', command: { payrollId: 'p1', reason: '支付信息有误' } });
  });

  it('shows readable category and channel labels in real manual transactions', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const transaction = { id: 'm1', kind: 'INCOME', incomeCategory: 'BOOK_SALE', expenseCategory: null, amount: '1.00', channel: 'CASH', occurredAt: '2026-10-19T04:45:00.000Z', note: null, createdAt: '2026-10-19T04:45:00.000Z' };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      const body = path === '/api/auth/me'
        ? { id: 'u1', username: 'owner', role: 'OWNER' }
        : path === '/api/assistant/status'
        ? { available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-19T04:45:00.000Z', message: 'AI 助手已连接' }
        : path.startsWith('/api/manual-transactions?') ? [transaction] : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    renderApp('/structured/finance');
    await user.click(await screen.findByRole('tab', { name: '手工收支' }));
    const table = await screen.findByRole('table', { name: '手工收支列表' });
    expect(within(table).getByText('卖书')).toBeInTheDocument();
    expect(within(table).getByText('现金')).toBeInTheDocument();
    expect(within(table).queryByText('BOOK_SALE')).not.toBeInTheDocument();
  });

  it('uses the logged-in JWT and an idempotency key for lesson completion', async () => {
    const user = userEvent.setup();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return Promise.resolve(new Response(JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }), { status: 200 }));
      if (path === '/api/assistant/status') return Promise.resolve(new Response(JSON.stringify({ available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手暂不可用' }), { status: 200 }));
      if (path.startsWith('/api/lessons?')) return Promise.resolve(new Response(JSON.stringify([{ id: 'l1', accountId: 'a1', teacherId: 't1', startsAt: `${today}T10:00:00+08:00`, endsAt: `${today}T11:00:00+08:00`, status: 'SCHEDULED', student: { id: 's1', name: '真实学生' }, course: { id: 'c1', name: '钢琴课' }, unitPriceSnapshot: null }]), { status: 200 }));
      if (path === '/api/students') return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      if (path === '/api/teachers') return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      if (path.startsWith('/api/students/') && path.endsWith('/course-accounts')) return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      if (path === '/api/assistant/previews/lessons/complete') return Promise.resolve(new Response(JSON.stringify({ previewId: '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d', actionType: 'lesson.complete', schemaVersion: 'lesson.complete.v1', riskLevel: 'L2', display: { title: '确认上课', summary: '确认课程完成' }, expiresAt: '2099-10-21T02:00:00.000Z' }), { status: 201 }));
      if (path === '/api/assistant/previews/0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d') return Promise.resolve(new Response(JSON.stringify({ ...previewState('0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d'), actionType: 'lesson.complete', schemaVersion: 'lesson.complete.v1' }), { status: 200 }));
      if (path === '/api/assistant/previews/0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d/confirm') return Promise.resolve(new Response(JSON.stringify({ previewId: '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d', status: 'EXECUTED', receipt: { actionType: 'lesson.complete', lessonId: 'l1', status: 'COMPLETED', startsAt: `${today}T10:00:00+08:00`, endsAt: `${today}T11:00:00+08:00`, unitPriceSnapshot: '120.00', idempotencyKey: 'technical-key' } }), { status: 200 }));
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp('/structured/schedule');

    await user.click(await screen.findByRole('button', { name: /真实学生.*钢琴课/ }));
    await user.click(await screen.findByRole('button', { name: '确认上课' }));
    expect(await screen.findByText('确认课程完成')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    expect(await screen.findByText('课程已确认完成')).toBeInTheDocument();
    expect(await screen.findByText('执行回执')).toBeInTheDocument();
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0);
    expect(screen.getByText('上课计费单价')).toBeInTheDocument();
    expect(screen.getAllByText('¥120.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/l1|technical-key/)).not.toBeInTheDocument();
    const completeCall = fetchMock.mock.calls.find(([path]) => path === '/api/assistant/previews/lessons/complete');
    expect(new Headers(completeCall?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    const confirmCall = fetchMock.mock.calls.find(([path]) => path === '/api/assistant/previews/0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d/confirm');
    expect(new Headers(confirmCall?.[1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('sends a prompt to the public gateway and displays the streamed reply and final status', async () => {
    const user = userEvent.setup();
    const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({
              type: 'workspace.replace',
              document: {
                protocolVersion: '1.0',
                title: '今日真实经营摘要',
                blocks: [
                  { type: 'summary', title: '排课情况', text: '今日共有 2 节排课。' },
                  { type: 'alert-list', alerts: [{ severity: 'warning', title: '待确认课消', detail: '有 1 节课程等待确认。' }] },
                  { type: 'metric-grid', metrics: [{ label: '今日排课', value: '2 节', tone: 'positive' }] },
                  { type: 'data-table', columns: [{ key: 'time', label: '时间' }, { key: 'student', label: '学生' }, { key: 'course', label: '课程' }], rows: [{ time: '09:00', student: '小明', course: '主课' }] },
                ],
                sources: [],
              },
            })}\n\n`));
            controller.enqueue(encoder.encode('event: assistant.delta\ndata: {"type":"assistant.delta","text":"今天有 2 节真实排课。"}\n\n'));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '查看今日排课');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));

    expect(await screen.findByText('今天有 2 节真实排课。')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '经营工作区' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('示例入口')).getByRole('button', { name: '查看今日排课' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('示例入口')).getByRole('button', { name: '查看这个月收入' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('示例入口')).getByRole('button', { name: '今天经营情况怎么样' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('示例入口')).queryByRole('button', { name: '查找学生账户' })).not.toBeInTheDocument();
    expect(screen.getByText('今日真实经营摘要')).toBeInTheDocument();
    expect(screen.getByText('排课情况')).toBeInTheDocument();
    expect(screen.getByText('今日共有 2 节排课。')).toBeInTheDocument();
    expect(screen.getByText('待确认课消')).toBeInTheDocument();
    expect(screen.getByText('有 1 节课程等待确认。')).toBeInTheDocument();
    expect(screen.getByText('今日排课')).toBeInTheDocument();
    expect(screen.getByText('2 节')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '查询结果' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '小明' })).toBeInTheDocument();
    expect(screen.queryByText('工作方式')).not.toBeInTheDocument();
    expect(screen.queryByText('数据状态')).not.toBeInTheDocument();
    expect(screen.queryByText('操作方式')).not.toBeInTheDocument();
    expect(await screen.findByText('回复已生成')).toBeInTheDocument();
    const startCall = fetchMock.mock.calls.find(([path]) => path === '/api/assistant/runs');
    expect(new Headers(startCall?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    const startBody = JSON.parse(String(startCall?.[1]?.body)) as Record<string, unknown>;
    expect(startBody).toMatchObject({ message: '查看今日排课' });
    expect(startBody.threadId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(startBody.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    const eventsCall = fetchMock.mock.calls.find(([path]) => path === `/api/assistant/runs/${runId}/events`);
    expect(new Headers(eventsCall?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    expect(new Headers(eventsCall?.[1]?.headers).get('x-thread-id')).toBe(startBody.threadId);
  });

  it('retries JWT confirmation with a stable key and presents a readable receipt with collapsed technical fields', async () => {
    const user = userEvent.setup();
    const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const encoder = new TextEncoder();
    let confirmations = 0;
    const runBodies: Array<{ message: string; threadId: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { message: string; threadId: string };
        runBodies.push(body);
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'queued' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            if (runBodies.length === 1) controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '需要确认的操作', blocks: [{ type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '预览收款', riskLevel: 'L2', expiresAt: '2099-10-19T02:00:00.000Z' }] } })}\n\n`));
            if (runBodies.length > 1) controller.enqueue(encoder.encode(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '已读取已执行预览，继续使用最新业务状态。' })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(previewState(previewId)), { status: 200 });
      if (path === `/api/assistant/previews/${previewId}/confirm`) {
        confirmations += 1;
        if (confirmations === 1) return new Response(null, { status: 409 });
        return new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: { actionType: 'course-account.payment', paymentId: 'payment-001', amount: '120.00', details: { channel: 'WECHAT' } } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '预览收款');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    const previewCard = await screen.findByLabelText('操作预览');
    expect(within(previewCard).getByText('确认前请核对预览内容；确认后才会写入真实业务数据。')).toBeInTheDocument();
    expect(within(previewCard).getByText(/有效期至/)).toBeInTheDocument();
    const technicalDetails = previewCard.querySelector('details');
    expect(technicalDetails).not.toBeNull();
    expect(technicalDetails).not.toHaveAttribute('open');
    expect(technicalDetails).toHaveTextContent('查看技术详情');
    expect(technicalDetails).toHaveTextContent('course-account.payment');
    expect(technicalDetails).toHaveTextContent('course-account.payment.v1');
    expect(technicalDetails).toHaveTextContent('L2');
    expect(technicalDetails).toHaveTextContent(previewId);
    await user.click(within(previewCard).getByText('查看技术详情'));
    expect(technicalDetails).toHaveAttribute('open');
    await user.click(await screen.findByRole('button', { name: '确认并登记' }));
    expect(await screen.findByText(/预览已失效或已被其他请求确认/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试确认' }));
    expect(await screen.findByText('执行回执')).toBeInTheDocument();
    expect(within(screen.getByLabelText('执行回执')).getByText('登记金额')).toBeInTheDocument();
    const receiptTechnicalDetails = screen.getByLabelText('执行回执').querySelector('details');
    expect(receiptTechnicalDetails).toHaveTextContent('payment-001');
    expect(receiptTechnicalDetails).not.toHaveAttribute('open');
    expect(screen.queryByText('Core 回执明细')).not.toBeInTheDocument();
    expect(screen.queryByText(/Core 已确认/)).not.toBeInTheDocument();
    expect(screen.queryByText('工作方式')).not.toBeInTheDocument();
    expect(screen.getByText('payment-001')).toBeInTheDocument();
    expect(screen.getByText('120.00')).toBeInTheDocument();
    const persistedSessionKey = Object.keys(window.sessionStorage).find((key) => key.startsWith('pianomanager.assistant.session.v1:'));
    expect(JSON.parse(window.sessionStorage.getItem(persistedSessionKey!)!).confirmedPreviewIds).toContain(previewId);
    await user.type(screen.getByLabelText('经营问题'), '继续查看');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    expect(await screen.findByText('已读取已执行预览，继续使用最新业务状态。')).toBeInTheDocument();
    expect(runBodies[1]?.threadId).toBe(runBodies[0]?.threadId);
    await user.click(screen.getByRole('button', { name: '清空上下文' }));
    expect(runBodies).toHaveLength(2);
    const confirmCalls = fetchMock.mock.calls.filter(([path]) => String(path) === `/api/assistant/previews/${previewId}/confirm`);
    expect(confirmCalls).toHaveLength(2);
    expect(new Headers(confirmCalls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    const firstIdempotencyKey = new Headers(confirmCalls[0]?.[1]?.headers).get('Idempotency-Key');
    const secondIdempotencyKey = new Headers(confirmCalls[1]?.[1]?.headers).get('Idempotency-Key');
    expect(firstIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(secondIdempotencyKey).toBe(firstIdempotencyKey);
    expect(Object.values(window.sessionStorage)).not.toContain(expect.stringContaining('jwt-test'));
  });

  it('disables old preview and candidate actions while a new conversation is running', async () => {
    const user = userEvent.setup();
    const firstRunId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const secondRunId = '5f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const encoder = new TextEncoder();
    const runBodies: Array<{ message: string; threadId: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-20T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { message: string; threadId: string };
        runBodies.push(body);
        return new Response(JSON.stringify({ runId: runBodies.length === 1 ? firstRunId : secondRunId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${firstRunId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '旧工作区', blocks: [
              { type: 'entity-picker', title: '旧候选', candidates: [{ id: 'student-1', label: '旧学生' }] },
              { type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '旧预览', riskLevel: 'L2', expiresAt: '2099-10-20T02:00:00.000Z' },
            ], sources: [] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${firstRunId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/runs/${secondRunId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(previewState(previewId)), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '旧任务');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    await screen.findByRole('button', { name: '确认并登记' });
    await user.type(screen.getByLabelText('经营问题'), '新任务');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    await waitFor(() => expect(runBodies).toHaveLength(2));
    expect(screen.getByRole('button', { name: '确认并登记' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /选择候选.*旧学生/ })).toBeDisabled();
  });

  it('uses previewId as the preview card key so a new preview starts fresh', async () => {
    const user = userEvent.setup();
    const firstRunId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const secondRunId = '5f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const firstPreviewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const secondPreviewId = '1f1d4de6-36cb-4ec2-904d-c522927d8d0c';
    const encoder = new TextEncoder();
    const runBodies: Array<{ message: string; threadId: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-20T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { message: string; threadId: string };
        runBodies.push(body);
        return new Response(JSON.stringify({ runId: runBodies.length === 1 ? firstRunId : secondRunId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      const runId = path.endsWith(`/runs/${firstRunId}/events`) ? firstRunId : secondRunId;
      if (path === `/api/assistant/runs/${runId}/events`) {
        const currentPreviewId = runId === firstRunId ? firstPreviewId : secondPreviewId;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: runId === firstRunId ? '旧金额' : '更正金额', blocks: [{ type: 'action-preview', previewId: currentPreviewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: runId === firstRunId ? '旧收款金额' : '更正后的收款金额', riskLevel: 'L2', expiresAt: '2099-10-20T02:00:00.000Z' }], sources: [] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/previews/${firstPreviewId}/confirm` || path === `/api/assistant/previews/${secondPreviewId}/confirm`) {
        const currentPreviewId = path.includes(firstPreviewId) ? firstPreviewId : secondPreviewId;
        return new Response(JSON.stringify({ previewId: currentPreviewId, status: 'EXECUTED', receipt: { amount: currentPreviewId === firstPreviewId ? '100.00' : '120.00' } }), { status: 200 });
      }
      if (path === `/api/assistant/previews/${firstPreviewId}`) return new Response(JSON.stringify(previewState(firstPreviewId)), { status: 200 });
      if (path === `/api/assistant/previews/${secondPreviewId}`) return new Response(JSON.stringify(previewState(secondPreviewId)), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '旧金额');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    await user.click(await screen.findByRole('button', { name: '确认并登记' }));
    expect(await screen.findByText('执行回执')).toBeInTheDocument();
    await user.type(screen.getByLabelText('经营问题'), '更正金额');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    expect(await screen.findByRole('button', { name: '确认并登记' })).toBeEnabled();
    expect(screen.getByText('更正后的收款金额')).toBeInTheDocument();
  });

  it('wires error recovery retry to a safe new preview request', async () => {
    const user = userEvent.setup();
    const firstRunId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const secondRunId = '5f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const encoder = new TextEncoder();
    const runBodies: Array<{ message: string; threadId: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-20T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { message: string; threadId: string };
        runBodies.push(body);
        return new Response(JSON.stringify({ runId: runBodies.length === 1 ? firstRunId : secondRunId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      const runId = runBodies.length === 1 ? firstRunId : secondRunId;
      if (path === `/api/assistant/runs/${runId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            if (runBodies.length === 1) controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '需要恢复', blocks: [{ type: 'error-recovery', code: 'PREVIEW_STALE', message: '预览已失效', actions: ['repreview'] }], sources: [] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: runBodies.length === 1 ? '需要重新生成预览。' : '已生成新的预览。' })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '查看旧预览');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    await user.click(await screen.findByRole('button', { name: '重新生成预览' }));
    await waitFor(() => expect(runBodies).toHaveLength(2));
    expect(runBodies[1]?.message).toBe('重新生成预览');
  });

  it('disables confirmation for an expired preview without calling Core', async () => {
    const user = userEvent.setup();
    const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'queued' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '过期预览', blocks: [{ type: 'action-preview', previewId, actionType: 'new.action.type', schemaVersion: 'new.action.type.v1', title: '过期操作', riskLevel: 'L1', expiresAt: '2020-01-01T00:00:00.000Z' }] } })}\n\n`)); controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`)); controller.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(previewState(previewId, 'EXPIRED', null, '2020-01-01T00:00:00.000Z')), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    renderApp();
    await user.type(await screen.findByLabelText('经营问题'), '查看过期预览');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    const expiredButton = await screen.findByRole('button', { name: '预览已过期' });
    expect(expiredButton).toBeDisabled();
    expect(screen.getByText('预览已过期，未执行任何操作。请重新生成预览。')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes(`/api/assistant/previews/${previewId}/confirm`))).toBe(false);
  });

  it('keeps one thread for follow-ups, shows message history, and sends a current candidate selection', async () => {
    const user = userEvent.setup();
    const firstRunId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const secondRunId = '5f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const encoder = new TextEncoder();
    const runBodies: Array<{ message: string; threadId: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-19T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { message: string; threadId: string };
        runBodies.push(body);
        const runId = body.message.startsWith('选择候选:') ? secondRunId : firstRunId;
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${firstRunId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: firstRunId, markdown: '请从候选中选择学生。' })}\n\n`));
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '选择学生', taskVersion: 7, blocks: [{ type: 'entity-picker', title: '学生候选', candidates: [{ id: 'student-1', label: '小明', description: '主课' }] }], sources: [] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${firstRunId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/runs/${secondRunId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: secondRunId, markdown: '已收到候选学生。' })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${secondRunId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '查找小明');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));

    expect(await screen.findByText('请从候选中选择学生。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /选择候选.*小明/ })).toBeEnabled();
    const firstThreadId = runBodies[0]?.threadId;
    await user.click(screen.getByRole('button', { name: /选择候选.*小明/ }));

    await waitFor(() => expect(runBodies).toHaveLength(2));
    expect(runBodies[1]).toMatchObject({ message: '选择候选:student-1:7', threadId: firstThreadId });
    expect(screen.getByText('查找小明')).toBeInTheDocument();
    expect(screen.getByText('选择候选:student-1:7')).toBeInTheDocument();
    expect(screen.getByText('已收到候选学生。')).toBeInTheDocument();
  });

  it('restores the active actor conversation from sessionStorage after a refresh', async () => {
    const user = userEvent.setup();
    const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const encoder = new TextEncoder();
    const runBodies: Array<{ message: string; threadId: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-19T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { message: string; threadId: string };
        runBodies.push(body);
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '已从服务端收到。' })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const firstRender = renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '查余额');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    expect(await screen.findByText('已从服务端收到。')).toBeInTheDocument();
    const firstThreadId = runBodies[0]?.threadId;

    firstRender.unmount();
    renderApp();
    expect(await screen.findByText('查余额')).toBeInTheDocument();
    expect(screen.getByText('已从服务端收到。')).toBeInTheDocument();
    await user.type(screen.getByLabelText('经营问题'), '继续解释');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    await waitFor(() => expect(runBodies).toHaveLength(2));
    expect(runBodies[1]?.threadId).toBe(firstThreadId);
  });

  it('cancels a pending preview on the old thread before starting a fresh conversation', async () => {
    const user = userEvent.setup();
    const firstRunId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const cancelRunId = '5f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const newRunId = '6f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const encoder = new TextEncoder();
    const runBodies: Array<{ message: string; threadId: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-19T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { message: string; threadId: string };
        runBodies.push(body);
        const runId = body.message === '取消当前办理' ? cancelRunId : body.message === '新任务' ? newRunId : firstRunId;
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${firstRunId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '待确认预览', blocks: [{ type: 'summary', title: '旧上下文', text: '旧任务内容' }, { type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '待确认收款', riskLevel: 'L2', expiresAt: '2099-10-19T02:00:00.000Z' }], sources: [] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: firstRunId, markdown: '旧任务回复' })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${firstRunId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/runs/${cancelRunId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: cancelRunId, markdown: '已取消当前待办理事项，未执行业务变更。' })}\n\n`));
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '已取消办理', blocks: [{ type: 'summary', title: '已取消办理', text: '待办理预览已失效。' }], sources: [] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${cancelRunId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/runs/${newRunId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: newRunId, markdown: '新任务已开始。' })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${newRunId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(previewState(previewId)), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '旧任务');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    expect(await screen.findByText('待确认预览')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清空上下文' }));
    expect(screen.queryByText('待确认预览')).not.toBeInTheDocument();
    expect(screen.queryByText('旧任务回复')).not.toBeInTheDocument();
    await waitFor(() => expect(runBodies).toHaveLength(2));
    expect(runBodies[1]).toMatchObject({ message: '取消当前办理', threadId: runBodies[0]?.threadId });
    await user.type(screen.getByLabelText('经营问题'), '新任务');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    await waitFor(() => expect(runBodies).toHaveLength(3));
    expect(runBodies[2]?.threadId).not.toBe(runBodies[0]?.threadId);
    await user.click(screen.getByRole('button', { name: '清空上下文' }));
    expect(runBodies).toHaveLength(3);
  });

  it('restores an executed preview from Core and never offers confirmation again', async () => {
    const user = userEvent.setup();
    const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-21T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'queued' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '恢复后的收款', blocks: [{ type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '恢复收款', riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z' }] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify({
        previewId,
        actionType: 'course-account.payment',
        schemaVersion: 'course-account.payment.v1',
        riskLevel: 'L2',
        status: 'EXECUTED',
        expiresAt: '2099-10-21T02:00:00.000Z',
        receipt: { paymentId: 'payment-restored', amount: '120.00' },
      }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '恢复收款');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));

    const previewCard = await screen.findByLabelText('操作预览');
    expect(await within(previewCard).findByText('执行回执')).toBeInTheDocument();
    expect(within(previewCard).getByText('已确认并执行。')).toBeInTheDocument();
    expect(within(previewCard).getByText('payment-restored')).toBeInTheDocument();
    expect(within(previewCard).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input, request]) => String(input).endsWith(`/previews/${previewId}/confirm`) && request?.method === 'POST')).toBe(false);
  });

  it('keeps a preview unknown after GET failure and only permits a read-only recheck', async () => {
    const user = userEvent.setup();
    const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const encoder = new TextEncoder();
    let previewReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-21T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'queued' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '状态未知', blocks: [{ type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '未知收款', riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z' }] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/previews/${previewId}`) {
        previewReads += 1;
        return new Response(null, { status: 503 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '状态未知');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));

    const previewCard = await screen.findByLabelText('操作预览');
    expect(await within(previewCard).findByText(/无法读取预览当前状态/)).toBeInTheDocument();
    expect(within(previewCard).getByRole('button', { name: '重查预览状态' })).toBeEnabled();
    expect(within(previewCard).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    await user.click(within(previewCard).getByRole('button', { name: '重查预览状态' }));
    await waitFor(() => expect(previewReads).toBe(2));
    expect(fetchMock.mock.calls.some(([input, request]) => String(input).endsWith(`/previews/${previewId}/confirm`) && request?.method === 'POST')).toBe(false);
  });

  it('keeps confirmation unknown after recovery sees PENDING and only rechecks until Core proves execution', async () => {
    const user = userEvent.setup();
    const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const encoder = new TextEncoder();
    let previewReads = 0;
    let confirmations = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-21T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'queued' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '确认结果未知', blocks: [{ type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '未知收款', riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z' }] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/previews/${previewId}`) {
        previewReads += 1;
        return new Response(JSON.stringify(previewState(previewId, previewReads >= 4 ? 'EXECUTED' : 'PENDING', previewReads >= 4 ? { paymentId: 'payment-after-unknown', amount: '120.00' } : null)), { status: 200 });
      }
      if (path === `/api/assistant/previews/${previewId}/confirm` && init?.method === 'POST') {
        confirmations += 1;
        return new Response(null, { status: 503 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '确认结果未知');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));

    const previewCard = await screen.findByLabelText('操作预览');
    await user.click(await within(previewCard).findByRole('button', { name: '确认并登记' }));
    expect(await within(previewCard).findByText(/确认请求结果未知/)).toBeInTheDocument();
    expect(within(previewCard).getByRole('button', { name: '重查预览状态' })).toBeEnabled();
    expect(within(previewCard).queryByRole('button', { name: '重试确认' })).not.toBeInTheDocument();
    expect(confirmations).toBe(1);

    await user.click(within(previewCard).getByRole('button', { name: '重查预览状态' }));
    expect(await within(previewCard).findByText('已确认并执行。')).toBeInTheDocument();
    expect(within(previewCard).getByText('payment-after-unknown')).toBeInTheDocument();
    expect(confirmations).toBe(1);
  });

  it('rechecks an old preview after an SSE disconnect before restoring confirmation', async () => {
    const user = userEvent.setup();
    const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const encoder = new TextEncoder();
    let previewReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-21T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '断线旧预览', blocks: [{ type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '断线收款', riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z' }] } })}\n\n`));
            setTimeout(() => controller.error(new Error('socket closed')), 0);
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/previews/${previewId}`) {
        previewReads += 1;
        return new Response(JSON.stringify(previewState(previewId, previewReads === 1 ? 'PENDING' : 'STALE')), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '断线旧预览');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    const previewCard = await screen.findByLabelText('操作预览');
    await waitFor(() => expect(previewReads).toBeGreaterThanOrEqual(2));
    expect(within(previewCard).getByRole('button', { name: '预览已失效' })).toBeDisabled();
    expect(within(previewCard).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input, request]) => String(input).endsWith(`/previews/${previewId}/confirm`) && request?.method === 'POST')).toBe(false);
  });
});
