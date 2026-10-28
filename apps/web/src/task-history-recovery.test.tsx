import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { WorkspaceBlock } from './assistant-client.js';

const threadId = '10000000-0000-4000-8000-000000000001';
const previewId = '20000000-0000-4000-8000-000000000002';
const previewBlock = {
  type: 'action-preview',
  previewId,
  actionType: 'course-account.payment',
  schemaVersion: 'course-account.payment.v1',
  title: '确认收款 ¥120.00',
  riskLevel: 'L2',
  expiresAt: '2099-10-28T00:00:00.000Z',
} as const;
const task = (workspacePreview: Extract<WorkspaceBlock, { type: 'action-preview' }> = previewBlock) => ({
  threadId,
  title: '历史任务',
  lastActivityAt: '2026-10-28T00:00:00.000Z',
  latestStatus: 'completed',
  messages: [{ id: 'm1', role: 'user', content: '收取 120 元', createdAt: '2026-10-28T00:00:00.000Z' }],
  workspace: { protocolVersion: '1.0', title: '历史任务确认单', blocks: [workspacePreview], sources: [] },
  historicalPreviews: [{ previewId: workspacePreview.previewId, actionType: workspacePreview.actionType, schemaVersion: workspacePreview.schemaVersion, riskLevel: workspacePreview.riskLevel }],
});

function renderHistory(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  window.localStorage.setItem('pianomanager.accessToken', 'jwt-current');
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[`/tasks/${threadId}`]}><App /></MemoryRouter></QueryClientProvider>);
}

function taskFetch(previewStatus: 'PENDING' | 'EXECUTED' | 'STALE' | 'EXPIRED', receipt: Record<string, unknown> | null = null, workspacePreview: Extract<WorkspaceBlock, { type: 'action-preview' }> = previewBlock) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'owner', role: 'OWNER' }));
    if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify(task(workspacePreview)));
    if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify({ previewId, actionType: previewBlock.actionType, schemaVersion: previewBlock.schemaVersion, riskLevel: previewBlock.riskLevel, status: previewStatus, expiresAt: previewBlock.expiresAt, receipt, display: { title: '当前收款确认', studentName: '小林', amount: '120.00' } }));
    if (path.endsWith(`/previews/${previewId}/confirm`) && init?.method === 'POST') return new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: { paymentId: 'should-not-confirm-again' } }));
    if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
    return new Response('{}', { status: 404 });
  });
}

describe('cross-session task recovery', () => {
  it.each([403, 404])('shows one non-disclosing message when task history returns HTTP %i', async (status) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'teacher', role: 'TEACHER', teacherId: 'teacher-current' }));
      if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify({ message: 'private owner task detail' }), { status });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    expect(await screen.findByText('该任务不存在或当前账号无权访问，请返回任务列表查看。')).toBeInTheDocument();
    expect(screen.queryByText('private owner task detail')).not.toBeInTheDocument();
    const read = fetchMock.mock.calls.find(([path]) => String(path) === `/api/assistant/tasks/${threadId}`);
    expect(new Headers(read?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-current');
  });

  it('keeps a generic service-unavailable message for task-history HTTP 503', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'teacher', role: 'TEACHER', teacherId: 'teacher-current' }));
      if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify({ message: 'private upstream detail' }), { status: 503 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    expect(await screen.findByText('请求失败 (503)')).toBeInTheDocument();
    expect(screen.queryByText('private upstream detail')).not.toBeInTheDocument();
  });

  it.each(['PENDING', 'STALE'] as const)('restores ordered, deduplicated multi-step previews from current system state when step two is %s', async (secondStatus) => {
    const firstPreviewId = '20000000-0000-4000-8000-000000000001';
    const secondPreviewId = '20000000-0000-4000-8000-000000000003';
    const historicalPreviews = [
      { previewId: firstPreviewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2' },
      { previewId: secondPreviewId, actionType: 'lesson.complete', schemaVersion: 'lesson.complete.v1', riskLevel: 'L1' },
      { previewId: firstPreviewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2' },
    ];
    const latestWorkspace = { protocolVersion: '1.0', title: 'PRIVATE LATEST STEP SNAPSHOT', blocks: [
      { type: 'summary', title: 'PRIVATE OLD STUDENT', text: '旧金额 ¥80.00' },
      { ...previewBlock, previewId: secondPreviewId, actionType: 'lesson.complete', schemaVersion: 'lesson.complete.v1', riskLevel: 'L1', title: 'PRIVATE OLD LESSON' },
    ], sources: [] };
    const detail = { ...task(), workspace: latestWorkspace, historicalPreviews };
    const previewReads: string[] = [];
    let confirmations = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'owner', role: 'OWNER' }));
      if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify(detail));
      if (/^\/api\/assistant\/previews\/[^/]+$/.test(path)) {
        const id = path.split('/').at(-1)!;
        previewReads.push(id);
        const first = id === firstPreviewId;
        return new Response(JSON.stringify({
          previewId: id,
          actionType: first ? 'course-account.payment' : 'lesson.complete',
          schemaVersion: first ? 'course-account.payment.v1' : 'lesson.complete.v1',
          riskLevel: first ? 'L2' : 'L1',
          status: first ? 'EXECUTED' : secondStatus,
          expiresAt: '2099-10-28T00:00:00.000Z',
          receipt: first ? { paymentId: 'first-step-real-receipt' } : null,
          display: { title: first ? '当前第一步确认' : '当前第二步确认', studentName: first ? '当前学生甲' : '当前学生乙', amount: first ? '80.00' : '120.00' },
        }));
      }
      if (path.endsWith('/confirm') && init?.method === 'POST') { confirmations += 1; return new Response('{}'); }
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    let mounted = renderHistory();
    const previews = await screen.findAllByLabelText('操作预览');
    expect(previews).toHaveLength(2);
    expect(await within(previews[0]!).findByText('当前第一步确认')).toBeInTheDocument();
    expect(within(previews[0]!).getByText('first-step-real-receipt')).toBeInTheDocument();
    expect(within(previews[1]!).getByText('当前第二步确认')).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE OLD STUDENT|PRIVATE OLD LESSON|旧金额 ¥80\.00|PRIVATE LATEST STEP SNAPSHOT/)).not.toBeInTheDocument();
    expect(previewReads).toEqual([firstPreviewId, secondPreviewId]);
    expect(confirmations).toBe(0);
    if (secondStatus === 'PENDING') expect(within(previews[1]!).getByRole('button', { name: '确认执行' })).toBeEnabled();
    else expect(within(previews[1]!).getByRole('button', { name: '预览已失效' })).toBeDisabled();

    mounted.unmount();
    previewReads.length = 0;
    mounted = renderHistory();
    const refreshed = await screen.findAllByLabelText('操作预览');
    expect(await within(refreshed[0]!).findByText('first-step-real-receipt')).toBeInTheDocument();
    expect(previewReads).toEqual([firstPreviewId, secondPreviewId]);
    expect(confirmations).toBe(0);
    mounted.unmount();
  });

  it('keeps an earlier still-pending preview read-only when a later workspace preview is current', async () => {
    const oldPreviewId = '20000000-0000-4000-8000-000000000004';
    const currentPreviewId = '20000000-0000-4000-8000-000000000005';
    const oldReference = { previewId: oldPreviewId, actionType: previewBlock.actionType, schemaVersion: previewBlock.schemaVersion, riskLevel: previewBlock.riskLevel };
    const currentReference = { previewId: currentPreviewId, actionType: 'lesson.complete', schemaVersion: 'lesson.complete.v1', riskLevel: 'L1' as const };
    const detail = {
      ...task(),
      workspace: { protocolVersion: '1.0', title: '历史确认单', blocks: [{ ...previewBlock, previewId: currentPreviewId, actionType: currentReference.actionType, schemaVersion: currentReference.schemaVersion, riskLevel: currentReference.riskLevel }], sources: [] },
      historicalPreviews: [oldReference, currentReference],
    };
    const confirmations: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'owner', role: 'OWNER' }));
      if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify(detail));
      if (path === `/api/assistant/previews/${oldPreviewId}` || path === `/api/assistant/previews/${currentPreviewId}`) {
        const current = path.endsWith(oldPreviewId) ? oldReference : currentReference;
        return new Response(JSON.stringify({ ...current, status: 'PENDING', expiresAt: '2099-10-28T00:00:00.000Z', receipt: null, display: { title: `当前 ${current.previewId === oldPreviewId ? '旧步骤' : '最新步骤'}`, studentName: '当前学生', amount: '120.00' } }));
      }
      if (path.endsWith('/confirm') && init?.method === 'POST') { confirmations.push(path); return new Response('{}'); }
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    const previews = await screen.findAllByLabelText('操作预览');
    expect(await within(previews[0]!).findByText('当前 旧步骤')).toBeInTheDocument();
    expect(within(previews[0]!).getByText('历史待确认步骤仅供查看，不能直接执行。')).toBeInTheDocument();
    expect(within(previews[0]!).queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
    expect(await within(previews[1]!).findByRole('button', { name: '确认执行' })).toBeEnabled();
    expect(confirmations).toEqual([]);
  });

  it('lets an earlier read-only preview be rechecked and reveal its current receipt', async () => {
    const user = (await import('@testing-library/user-event')).userEvent.setup();
    const oldPreviewId = '20000000-0000-4000-8000-000000000006';
    const currentPreviewId = '20000000-0000-4000-8000-000000000007';
    const oldReference = { previewId: oldPreviewId, actionType: previewBlock.actionType, schemaVersion: previewBlock.schemaVersion, riskLevel: previewBlock.riskLevel };
    const currentReference = { previewId: currentPreviewId, actionType: 'lesson.complete', schemaVersion: 'lesson.complete.v1', riskLevel: 'L1' as const };
    const detail = {
      ...task(),
      workspace: { protocolVersion: '1.0', title: '历史确认单', blocks: [{ ...previewBlock, previewId: currentPreviewId, actionType: currentReference.actionType, schemaVersion: currentReference.schemaVersion, riskLevel: currentReference.riskLevel }], sources: [] },
      historicalPreviews: [oldReference, currentReference],
    };
    let oldPreviewReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'owner', role: 'OWNER' }));
      if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify(detail));
      if (path === `/api/assistant/previews/${oldPreviewId}`) {
        oldPreviewReads += 1;
        if (oldPreviewReads === 1) return new Response('{}', { status: 503 });
        return new Response(JSON.stringify({ ...oldReference, status: 'EXECUTED', expiresAt: '2099-10-28T00:00:00.000Z', receipt: { paymentId: 'old-step-current-receipt' }, display: { title: '系统当前旧步骤' } }));
      }
      if (path === `/api/assistant/previews/${currentPreviewId}`) return new Response(JSON.stringify({ ...currentReference, status: 'PENDING', expiresAt: '2099-10-28T00:00:00.000Z', receipt: null, display: { title: '系统当前最新步骤' } }));
      if (path.endsWith('/confirm') && init?.method === 'POST') return new Response('{}');
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    const previews = await screen.findAllByLabelText('操作预览');
    expect(await within(previews[0]!).findByRole('button', { name: '重查预览状态' })).toBeEnabled();
    await user.click(within(previews[0]!).getByRole('button', { name: '重查预览状态' }));
    expect(await within(previews[0]!).findByText('old-step-current-receipt')).toBeInTheDocument();
    expect(within(previews[0]!).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path, request]) => String(path).endsWith(`/previews/${oldPreviewId}/confirm`) && request?.method === 'POST')).toBe(false);
  });

  it.each([
    ['actionType', { ...previewBlock, actionType: 'student.create' }],
    ['schemaVersion', { ...previewBlock, schemaVersion: 'course-account.payment.v2' }],
    ['riskLevel', { ...previewBlock, riskLevel: 'L1' }],
  ] as const)('blocks confirmation when historical %s differs from the current preview', async (_field, historicalPreview) => {
    const fetchMock = taskFetch('PENDING', null, historicalPreview);
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    const preview = await screen.findByLabelText('操作预览');
    expect(await within(preview).findByText('历史确认单与当前预览不一致，已禁止确认。请重新生成确认单。')).toBeInTheDocument();
    expect(within(preview).queryByRole('button', { name: /确认并登记|确认执行/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith(`/previews/${previewId}/confirm`) && init?.method === 'POST')).toBe(false);
  });

  it('shows Core display as the current confirmation facts instead of stale history summary or table', async () => {
    const userTask = { ...task(), workspace: { protocolVersion: '1.0', title: '旧历史工作区', blocks: [
      { type: 'summary', title: '历史对象', text: '学生：旧学生；金额：¥80.00' },
      { type: 'data-table', columns: [{ key: 'student', label: '学生' }, { key: 'amount', label: '金额' }], rows: [{ student: '旧学生', amount: '80.00' }] },
      previewBlock,
    ], sources: [] } };
    const fetchMock = taskFetch('PENDING');
    const baseFetch = fetchMock;
    const currentIdentityFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify(userTask));
      if (String(input) === `/api/assistant/previews/${previewId}`) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer jwt-current');
        return new Response(JSON.stringify({ previewId, actionType: previewBlock.actionType, schemaVersion: previewBlock.schemaVersion, riskLevel: previewBlock.riskLevel, status: 'PENDING', expiresAt: previewBlock.expiresAt, receipt: null, display: { title: '当前收款确认', studentName: '小林', amount: '120.00' } }));
      }
      return baseFetch(input, init);
    });
    vi.stubGlobal('fetch', currentIdentityFetch);
    renderHistory();

    const preview = await screen.findByLabelText('操作预览');
    const facts = await within(preview).findByLabelText('当前确认单内容');
    expect(within(preview).getByText('当前收款确认')).toBeInTheDocument();
    expect(within(facts).getByText('小林')).toBeInTheDocument();
    expect(within(facts).getAllByText('¥120.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('旧学生')).not.toBeInTheDocument();
    expect(screen.queryByText('¥80.00')).not.toBeInTheDocument();
    expect(within(preview).getByRole('button', { name: '确认并登记' })).toBeEnabled();
  });

  it('keeps teacher task and preview reads bound to the current teacher and displays Core-projected fields only', async () => {
    const teacherPreview = { ...previewBlock, actionType: 'lesson.complete', schemaVersion: 'lesson.complete.v1', title: '确认上课' };
    const teacherTask = { ...task(), workspace: { protocolVersion: '1.0', title: '教师历史任务', blocks: [teacherPreview], sources: [] }, historicalPreviews: [{ previewId: teacherPreview.previewId, actionType: teacherPreview.actionType, schemaVersion: teacherPreview.schemaVersion, riskLevel: teacherPreview.riskLevel }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'teacher-current', username: 'teacher', role: 'TEACHER', teacherId: 'teacher-1' }));
      if (path === `/api/assistant/tasks/${threadId}`) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer jwt-current');
        return new Response(JSON.stringify(teacherTask));
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify({
        previewId,
        actionType: teacherPreview.actionType,
        schemaVersion: teacherPreview.schemaVersion,
        riskLevel: teacherPreview.riskLevel,
        status: 'PENDING',
        expiresAt: teacherPreview.expiresAt,
        receipt: null,
        display: { title: '当前上课确认', studentName: '小林', courseName: '钢琴课', statusBefore: 'SCHEDULED', statusAfter: 'COMPLETED', auditEventId: 'private-audit-id' },
      }));
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    const preview = await screen.findByLabelText('操作预览');
    const facts = await within(preview).findByLabelText('当前确认单内容');
    expect(within(facts).getByText('小林')).toBeInTheDocument();
    expect(within(facts).getByText('钢琴课')).toBeInTheDocument();
    expect(within(facts).getByText('已完成')).toBeInTheDocument();
    expect(within(facts).queryByText('private-audit-id')).not.toBeInTheDocument();
    const taskRead = fetchMock.mock.calls.find(([path]) => String(path) === `/api/assistant/tasks/${threadId}`);
    const previewRead = fetchMock.mock.calls.find(([path]) => String(path) === `/api/assistant/previews/${previewId}`);
    expect(new Headers(taskRead?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-current');
    expect(new Headers(previewRead?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-current');
    expect(within(preview).getByRole('button', { name: '确认并登记' })).toBeEnabled();
  });

  it('shows no historical preview facts when a reassigned teacher fails the current Core permission check', async () => {
    const detail = { ...task(), title: '教师可访问的历史任务', workspace: { protocolVersion: '1.0', title: '历史任务确认单', blocks: [{ ...previewBlock, title: '历史确认单' }], sources: [] } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'teacher', role: 'TEACHER', teacherId: 'teacher-after-reassignment' }));
      if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify(detail));
      if (path === `/api/assistant/previews/${previewId}`) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer jwt-current');
        return new Response(JSON.stringify({ message: 'sensitive historical preview details' }), { status: 403 });
      }
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    const preview = await screen.findByLabelText('操作预览');
    expect(await within(preview).findByText('当前账号无权读取该预览。')).toBeInTheDocument();
    expect(within(preview).queryByText('确认收款 ¥120.00')).not.toBeInTheDocument();
    expect(within(preview).queryByText('历史确认单')).not.toBeInTheDocument();
    expect(within(preview).queryByText('sensitive historical preview details')).not.toBeInTheDocument();
    expect(within(preview).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path, request]) => String(path).endsWith(`/previews/${previewId}/confirm`) && request?.method === 'POST')).toBe(false);
  });

  it('re-reads Core and shows the real receipt for an already executed historical preview without confirming again', async () => {
    const fetchMock = taskFetch('EXECUTED', { paymentId: 'payment-real-42', amount: '120.00' });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    const preview = await screen.findByLabelText('操作预览');
    expect(await within(preview).findByText('已确认并执行。')).toBeInTheDocument();
    expect(within(preview).getByText('payment-real-42')).toBeInTheDocument();
    expect(within(preview).queryByRole('button', { name: /确认并登记|确认执行/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith(`/previews/${previewId}/confirm`) && init?.method === 'POST')).toBe(false);
    const read = fetchMock.mock.calls.find(([path]) => String(path) === `/api/assistant/previews/${previewId}`);
    expect(new Headers(read?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-current');
  });

  it('restores a pending historical preview using Core state and requires an explicit user confirmation', async () => {
    const user = (await import('@testing-library/user-event')).userEvent.setup();
    const fetchMock = taskFetch('PENDING');
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    const preview = await screen.findByLabelText('操作预览');
    const confirm = await within(preview).findByRole('button', { name: '确认并登记' });
    expect(confirm).toBeEnabled();
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith(`/previews/${previewId}/confirm`) && init?.method === 'POST')).toBe(false);
    await user.click(confirm);
    expect(await within(preview).findByText('should-not-confirm-again')).toBeInTheDocument();
  });

  it('invalidates home queries after historical confirmation and re-reads executed state when continuing the task', async () => {
    const user = (await import('@testing-library/user-event')).userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    let currentStatus: 'PENDING' | 'EXECUTED' = 'PENDING';
    let previewReads = 0;
    let confirmations = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'owner', role: 'OWNER' }));
      if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify(task()));
      if (path === `/api/assistant/previews/${previewId}`) {
        previewReads += 1;
        return new Response(JSON.stringify({ previewId, actionType: previewBlock.actionType, schemaVersion: previewBlock.schemaVersion, riskLevel: previewBlock.riskLevel, status: currentStatus, expiresAt: previewBlock.expiresAt, receipt: currentStatus === 'EXECUTED' ? { paymentId: 'payment-after-confirm', amount: '120.00' } : null, display: { title: '当前收款确认', studentName: '小林', amount: '120.00' } }));
      }
      if (path.endsWith(`/previews/${previewId}/confirm`) && init?.method === 'POST') {
        confirmations += 1;
        currentStatus = 'EXECUTED';
        return new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: { paymentId: 'payment-after-confirm', amount: '120.00' } }));
      }
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory(queryClient);

    const preview = await screen.findByLabelText('操作预览');
    await user.click(await within(preview).findByRole('button', { name: '确认并登记' }));
    expect(await within(preview).findByText('payment-after-confirm')).toBeInTheDocument();
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['home-overview'] }));
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['assistant-tasks'] }));
    });

    await user.click(screen.getByRole('button', { name: '继续此任务' }));
    const resumedPreview = await screen.findByLabelText('操作预览');
    expect(await within(resumedPreview).findByText('payment-after-confirm')).toBeInTheDocument();
    expect(previewReads).toBeGreaterThanOrEqual(2);
    expect(confirmations).toBe(1);
  });

  it('keeps the Core display requirement when a historical task is continued on the home workspace', async () => {
    const user = (await import('@testing-library/user-event')).userEvent.setup();
    let previewReads = 0;
    let confirmations = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'owner', role: 'OWNER' }));
      if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify(task()));
      if (path === `/api/assistant/previews/${previewId}`) {
        previewReads += 1;
        return new Response(JSON.stringify({ previewId, actionType: previewBlock.actionType, schemaVersion: previewBlock.schemaVersion, riskLevel: previewBlock.riskLevel, status: 'PENDING', expiresAt: previewBlock.expiresAt, receipt: null, ...(previewReads === 1 ? { display: { title: '当前收款确认', studentName: '小林', amount: '120.00' } } : {}) }));
      }
      if (path.endsWith(`/previews/${previewId}/confirm`) && init?.method === 'POST') confirmations += 1;
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    await screen.findByRole('button', { name: '确认并登记' });
    await user.click(screen.getByRole('button', { name: '继续此任务' }));
    const resumedPreview = await screen.findByLabelText('操作预览');
    expect(await within(resumedPreview).findByText('系统未提供当前确认内容，已禁止确认。请重新生成确认单。')).toBeInTheDocument();
    expect(within(resumedPreview).queryByRole('button', { name: /确认并登记|确认执行/ })).not.toBeInTheDocument();
    expect(previewReads).toBeGreaterThanOrEqual(2);
    expect(confirmations).toBe(0);
  });

  it('clearly marks stale previews and surfaces Core authorization failures without enabling confirmation', async () => {
    const staleFetch = taskFetch('STALE');
    vi.stubGlobal('fetch', staleFetch);
    const staleRender = renderHistory();
    const stale = await screen.findByLabelText('操作预览');
    expect(await within(stale).findByRole('button', { name: '预览已失效' })).toBeDisabled();
    expect(within(stale).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    staleRender.unmount();

    const expiredFetch = taskFetch('EXPIRED');
    vi.stubGlobal('fetch', expiredFetch);
    const expiredRender = renderHistory();
    const expired = await screen.findByLabelText('操作预览');
    expect(await within(expired).findByRole('button', { name: '预览已过期' })).toBeDisabled();
    expect(within(expired).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    expiredRender.unmount();

    const forbiddenFetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-current', username: 'owner', role: 'OWNER' }));
      if (path === `/api/assistant/tasks/${threadId}`) return new Response(JSON.stringify(task()));
      if (path === `/api/assistant/previews/${previewId}`) return new Response('无权读取该预览', { status: 403 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: new Date().toISOString(), message: 'AI 助手已连接' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', forbiddenFetch);
    renderHistory();
    const denied = await screen.findByLabelText('操作预览');
    expect(await within(denied).findByText('当前账号无权读取该预览。')).toBeInTheDocument();
    expect(within(denied).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    expect(within(denied).queryByText('确认收款 ¥120.00')).not.toBeInTheDocument();
    expect(within(denied).queryByText('当前收款确认')).not.toBeInTheDocument();
    expect(within(denied).queryByLabelText('当前确认单内容')).not.toBeInTheDocument();
  });

  it('does not reuse a cached historical task workspace from another login identity', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['assistant-task', threadId], { ...task(), title: '另一用户的缓存任务' });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/assistant/tasks/${threadId}`) await new Promise((resolve) => setTimeout(resolve, 80));
      return taskFetch('PENDING')(input, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHistory(queryClient);

    await screen.findByText('owner');
    expect(screen.queryByRole('heading', { name: '另一用户的缓存任务' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '历史任务' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === `/api/assistant/tasks/${threadId}`)).toBe(true));
    expect(screen.queryByRole('heading', { name: '另一用户的缓存任务' })).not.toBeInTheDocument();
    const detail = fetchMock.mock.calls.find(([path]) => String(path) === `/api/assistant/tasks/${threadId}`);
    expect(new Headers(detail?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-current');
  });
});
