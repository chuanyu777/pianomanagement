import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BasicDataWorkbench } from './basic-data-workbench.js';

const previewId = 'c87af11b-a40f-42cc-92b1-d176c9ad2ea1';
const teacherId = '61ae3054-8c04-4f64-9ef1-2f912cd337c4';
const courseId = 'aa3511c0-e9be-4ca5-bef3-ff9e8e725ce5';

function renderWorkbench() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><BasicDataWorkbench /></QueryClientProvider>);
}

function pendingPreview() {
  return { previewId, actionType: 'teacher.create', schemaVersion: 'teacher.create.v1', riskLevel: 'L1', expiresAt: '2099-10-28T00:00:00.000Z', display: { title: '新增教师资料', summary: '林老师' } };
}

describe('BasicDataWorkbench', () => {
  it('loads actual teacher and course records from Core', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const payload = path === '/api/teachers'
        ? [{ id: teacherId, userId: null, username: null, name: '真实教师', isActive: true, defaultBaseSalary: '3200.00', defaultCommissionRate: '8.0000' }]
        : path === '/api/courses'
          ? [{ id: courseId, name: '真实课程', defaultUnitPrice: '280.00', defaultDurationMinutes: 45, isActive: true }]
          : [];
      return new Response(JSON.stringify(payload), { status: 200 });
    }));

    renderWorkbench();

    expect(await screen.findByText('真实教师')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '课程管理' }));
    expect(await screen.findByText('真实课程')).toBeInTheDocument();
  });

  it('creates teacher records through structured-action preview and browser confirmation', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/teachers' || path === '/api/courses') return new Response('[]', { status: 200 });
      if (path === '/api/assistant/previews/structured-action') return new Response(JSON.stringify(pendingPreview()), { status: 201 });
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify({ ...pendingPreview(), status: 'PENDING', receipt: null }), { status: 200 });
      if (path === `/api/assistant/previews/${previewId}/confirm`) return new Response(JSON.stringify({ ...pendingPreview(), status: 'EXECUTED', receipt: { teacherId } }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(await screen.findByRole('button', { name: '新增教师' }));
    await user.type(screen.getByLabelText('教师姓名'), '林老师');
    await user.clear(screen.getByLabelText('默认基本工资'));
    await user.type(screen.getByLabelText('默认基本工资'), '3200.00');
    await user.clear(screen.getByLabelText('默认提成比例'));
    await user.type(screen.getByLabelText('默认提成比例'), '8.0000');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/assistant/previews/structured-action'), JSON.stringify(fetchMock.mock.calls.map(([path, init]) => [String(path), init?.method]))).toBe(true));
    const previewCall = fetchMock.mock.calls.find(([path]) => String(path) === '/api/assistant/previews/structured-action');
    expect(JSON.parse(String(previewCall?.[1]?.body))).toMatchObject({ actionType: 'teacher.create', command: { name: '林老师', baseSalary: '3200.00', commissionRate: '8.0000' } });
    expect(fetchMock.mock.calls.some(([path, init]) => ['/api/teachers', '/api/courses'].includes(String(path)) && ['POST', 'PATCH'].includes(init?.method ?? 'GET'))).toBe(false);

    await user.click(await screen.findByRole('button', { name: '确认执行' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === `/api/assistant/previews/${previewId}/confirm`)).toBe(true));
    const confirmCall = fetchMock.mock.calls.find(([path]) => String(path) === `/api/assistant/previews/${previewId}/confirm`);
    expect(confirmCall?.[1]?.method).toBe('POST');
    expect(confirmCall?.[1]?.body).toBeUndefined();
    expect(within(await screen.findByRole('dialog')).getByText('执行回执')).toBeInTheDocument();
  });

  it('previews teacher compensation and course create and edit actions', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const actions: Array<{ actionType: string; command: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/teachers') return new Response(JSON.stringify([{ id: teacherId, userId: null, username: null, name: '真实教师', isActive: true, defaultBaseSalary: '3200.00', defaultCommissionRate: '8.0000' }]), { status: 200 });
      if (path === '/api/courses') return new Response(JSON.stringify([{ id: courseId, name: '真实课程', defaultUnitPrice: '280.00', defaultDurationMinutes: 45, isActive: true }]), { status: 200 });
      if (path === '/api/assistant/previews/structured-action') {
        actions.push(JSON.parse(String(init?.body)) as { actionType: string; command: Record<string, unknown> });
        return new Response(JSON.stringify(pendingPreview()), { status: 201 });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify({ ...pendingPreview(), status: 'PENDING', receipt: null }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(await screen.findByRole('button', { name: '修改薪酬' }));
    await user.clear(screen.getByLabelText('默认基本工资'));
    await user.type(screen.getByLabelText('默认基本工资'), '3500.00');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));
    await waitFor(() => expect(actions[0]?.actionType).toBe('teacher.compensation.update'));
    expect(actions[0]?.command).toMatchObject({ teacherId, baseSalary: '3500.00', commissionRate: '8.0000' });

    await user.click(screen.getByRole('button', { name: /关.*闭/ }));
    await user.click(screen.getByRole('tab', { name: '课程管理' }));
    await user.click(await screen.findByRole('button', { name: '新增课程' }));
    await user.type(screen.getByLabelText('课程名称'), '启蒙课');
    await user.clear(screen.getByLabelText('课程默认单价'));
    await user.type(screen.getByLabelText('课程默认单价'), '300.00');
    await user.clear(screen.getByLabelText('默认课时（分钟）'));
    await user.type(screen.getByLabelText('默认课时（分钟）'), '45');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));
    await waitFor(() => expect(actions[1]?.actionType).toBe('course.create'));
    expect(actions[1]?.command).toMatchObject({ name: '启蒙课', defaultUnitPrice: '300.00', defaultDurationMinutes: 45 });

    await user.click(screen.getByRole('button', { name: /关.*闭/ }));
    await user.click(await screen.findByRole('button', { name: '编辑课程' }));
    await user.clear(screen.getByLabelText('课程名称'));
    await user.type(screen.getByLabelText('课程名称'), '真实课程更新');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));
    await waitFor(() => expect(actions[2]?.actionType).toBe('course.update'));
    expect(actions[2]?.command).toMatchObject({ courseId, name: '真实课程更新' });
  }, 15000);

  it('opens an account for a newly created teacher only after profile confirmation, sending the password to Core with JWT', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const createdTeacher = { id: teacherId, userId: null, username: null, name: '新教师', isActive: true, defaultBaseSalary: '0.00', defaultCommissionRate: '0.0000' };
    let profileCreated = false;
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, ...(init ? { init } : {}) });
      if (path === '/api/teachers') return new Response(JSON.stringify(profileCreated ? [createdTeacher] : []), { status: 200 });
      if (path === '/api/courses') return new Response('[]', { status: 200 });
      if (path === '/api/assistant/previews/structured-action') return new Response(JSON.stringify(pendingPreview()), { status: 201 });
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify({ ...pendingPreview(), status: 'PENDING', receipt: null }), { status: 200 });
      if (path === `/api/assistant/previews/${previewId}/confirm`) {
        profileCreated = true;
        return new Response(JSON.stringify({ ...pendingPreview(), status: 'EXECUTED', receipt: { teacherId } }), { status: 200 });
      }
      if (path === `/api/teachers/${teacherId}/login-account`) return new Response(JSON.stringify({ ...createdTeacher, userId: 'user-id', username: 'teacher.new' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(await screen.findByRole('button', { name: '新增教师' }));
    await user.type(screen.getByLabelText('教师姓名'), '新教师');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));
    await user.click(await screen.findByRole('button', { name: '确认执行' }));
    await user.click(await screen.findByRole('button', { name: '开通登录账号' }));
    await user.type(screen.getByLabelText('登录用户名'), 'teacher.new');
    await user.type(screen.getByLabelText('初始密码（12 至 128 个字符）'), 'new-private-password');
    await user.type(screen.getByLabelText('再次输入初始密码'), 'new-private-password');
    await user.click(screen.getByRole('button', { name: '继续确认' }));
    await user.click(screen.getByRole('button', { name: '确认并开通' }));

    await waitFor(() => expect(calls.some(({ path }) => path === `/api/teachers/${teacherId}/login-account`)).toBe(true));
    const accountCall = calls.find(({ path }) => path === `/api/teachers/${teacherId}/login-account`);
    expect(accountCall?.init?.method).toBe('POST');
    expect(new Headers(accountCall?.init?.headers).get('Authorization')).toBe('Bearer jwt-test');
    expect(JSON.parse(String(accountCall?.init?.body))).toEqual({ username: 'teacher.new', password: 'new-private-password' });
    const previewCalls = calls.filter(({ path }) => path.includes('/api/assistant/previews'));
    expect(previewCalls.every(({ init }) => !String(init?.body ?? '').includes('new-private-password'))).toBe(true);
    expect(window.localStorage.getItem('pianomanager.accessToken')).toBe('jwt-test');
    expect(window.localStorage.getItem('pianomanager.accessToken')).not.toContain('new-private-password');
    expect(Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.getItem(window.sessionStorage.key(index) ?? '') ?? '').join(' ')).not.toContain('new-private-password');
    expect(await screen.findByText('已为新教师开通登录账号：teacher.new')).toBeInTheDocument();
  });

  it('rechecks the teacher after the account request response is lost and never submits creation twice', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const unbound = { id: teacherId, userId: null, username: null, name: '已有教师', isActive: true, defaultBaseSalary: '0.00', defaultCommissionRate: '0.0000' };
    const bound = { ...unbound, userId: 'user-id', username: 'teacher.existing' };
    let committed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/teachers') return new Response(JSON.stringify([committed ? bound : unbound]), { status: 200 });
      if (path === '/api/courses') return new Response('[]', { status: 200 });
      if (path === `/api/teachers/${teacherId}/login-account`) {
        committed = true;
        throw new TypeError('Failed to fetch');
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(await screen.findByRole('button', { name: '开通登录账号' }));
    expect(within(screen.getByRole('dialog')).queryByText(/Core|AI|浏览器/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('登录用户名'), 'teacher.existing');
    await user.type(screen.getByLabelText('初始密码（12 至 128 个字符）'), 'response-lost-secret');
    await user.type(screen.getByLabelText('再次输入初始密码'), 'response-lost-secret');
    await user.click(screen.getByRole('button', { name: '继续确认' }));
    await user.click(screen.getByRole('button', { name: '确认并开通' }));

    expect(await screen.findByText('当前账号状态：该教师已绑定登录账号 teacher.existing')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === `/api/teachers/${teacherId}/login-account`)).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === '/api/teachers').length).toBeGreaterThan(1);
    expect(document.body).not.toHaveTextContent('response-lost-secret');
    expect(screen.queryByRole('button', { name: '开通登录账号' })).not.toBeInTheDocument();
  }, 15000);

  it('reports the rechecked unbound state after a lost response without retrying account creation', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const unbound = { id: teacherId, userId: null, username: null, name: '已有教师', isActive: true, defaultBaseSalary: '0.00', defaultCommissionRate: '0.0000' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/teachers') return new Response(JSON.stringify([unbound]), { status: 200 });
      if (path === '/api/courses') return new Response('[]', { status: 200 });
      if (path === `/api/teachers/${teacherId}/login-account`) throw new TypeError('Failed to fetch');
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(await screen.findByRole('button', { name: '开通登录账号' }));
    await user.type(screen.getByLabelText('登录用户名'), 'teacher.existing');
    await user.type(screen.getByLabelText('初始密码（12 至 128 个字符）'), 'response-lost-secret');
    await user.type(screen.getByLabelText('再次输入初始密码'), 'response-lost-secret');
    await user.click(screen.getByRole('button', { name: '继续确认' }));
    await user.click(screen.getByRole('button', { name: '确认并开通' }));

    expect(await screen.findByText('当前教师仍未绑定登录账号；系统没有自动重复提交。确认状态后可再次发起开通。')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === `/api/teachers/${teacherId}/login-account`)).toHaveLength(1);
    expect(document.body).not.toHaveTextContent('response-lost-secret');
  }, 15000);

  it('does not offer account opening or password reset for a teacher that already has a login', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const bound = { id: teacherId, userId: 'user-id', username: 'teacher.bound', name: '已绑定教师', isActive: true, defaultBaseSalary: '0.00', defaultCommissionRate: '0.0000' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/teachers'
      ? new Response(JSON.stringify([bound]), { status: 200 })
      : new Response('[]', { status: 200 })));
    renderWorkbench();

    expect(await screen.findByText('teacher.bound')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开通登录账号' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重设密码|重置密码/ })).not.toBeInTheDocument();
  });
});
