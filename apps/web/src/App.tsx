import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { Alert, Button, Card, Input, Tag, Typography } from 'antd';
import { HistoricalPreviewReferenceSchema, WorkspaceDocumentSchema, type HistoricalPreviewReference } from '@piano/assistant-protocol';
import type { components } from '@piano/generated-core-client/generated/core-api';
import { Link, Outlet, Route, Routes, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { AUTH_EXPIRED_EVENT, confirmAssistantPreview, createAssistantIds, getAssistantPreview, isTerminalAssistantEvent, notifyAuthExpired, startAssistantRun, streamAssistantEvents, UnknownConfirmationError, type AssistantRunStatus, type AssistantUiEvent, type WorkspaceBlock, type WorkspaceDocument } from './assistant-client.js';
import { clearSession, getAccessToken, getRefreshToken, refreshSession, revokeSession, ServiceUnavailableError, SessionExpiredError, storeSession } from './auth-session.js';
import { PreviewFacts } from './preview-facts.js';
import { StructuredWorkbench } from './structured-workbench.js';

const { Text, Title } = Typography;
const { TextArea } = Input;

type NavIconName = 'home' | 'students' | 'schedule' | 'finance' | 'settings';
type NavItem = { label: string; description: string; path: string; icon: NavIconName };
const navItems: NavItem[] = [
  { label: '今日中枢', description: 'AI 协同入口', path: '/', icon: 'home' },
  { label: '学生与账户', description: '学生与资金', path: '/students', icon: 'students' },
  { label: '排课与课消', description: '周视图与课消', path: '/schedule', icon: 'schedule' },
  { label: '收支与报表', description: '经营与现金', path: '/finance', icon: 'finance' },
  { label: '教师与课程', description: '基础资料', path: '/settings', icon: 'settings' },
];
const suggestions = ['查看今日排课', '查看这个月收入', '今天经营情况怎么样'];

type AssistantState = {
  available: boolean;
  core: { available: boolean };
  agentRuntime: { available: boolean };
  checkedAt: string;
  message: 'AI 助手已连接' | 'AI 助手暂不可用';
};
type AuthUser = { id: string; username: string; role: string; teacherId?: string };
type ConversationMessage = { id: string; role: 'user' | 'assistant'; text: string };
type WorkspaceWithTaskVersion = WorkspaceDocument & { taskVersion?: number };
type WorkspaceState = { document: WorkspaceDocument; threadId: string; requireCoreDisplay?: boolean };
type PersistedAssistantSession = { threadId: string; messages: ConversationMessage[]; workspace?: WorkspaceDocument; workspaceThreadId?: string; requireCorePreviewDisplay?: boolean; confirmedPreviewIds?: string[] };
type CandidateSelectionHandler = (candidateId: string, taskVersion?: number) => void;
type ClearConversationHandler = () => void;
type PreviewConfirmationHandler = (previewId: string) => void;
type RecoveryAction = Extract<WorkspaceBlock, { type: 'error-recovery' }>['actions'][number];
type RecoveryActionHandler = (action: RecoveryAction) => void;

const ACTOR_SESSION_KEY = 'pianomanager.assistant.actor';
const ASSISTANT_SESSION_PREFIX = 'pianomanager.assistant.session.v1:';
const PREVIEW_IDEMPOTENCY_KEY_PREFIX = 'pianomanager.preview.idempotency.v1:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

function formatAssistantReply(value: string): string {
  return value.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').trim();
}

function isAssistantState(value: unknown): value is AssistantState {
  if (!isRecord(value) || !isRecord(value.core) || !isRecord(value.agentRuntime)) return false;
  return typeof value.available === 'boolean' && typeof value.core.available === 'boolean' &&
    typeof value.agentRuntime.available === 'boolean' && hasString(value, 'checkedAt') &&
    (value.message === 'AI 助手已连接' || value.message === 'AI 助手暂不可用');
}

function isAuthUser(value: unknown): value is AuthUser {
  return isRecord(value) && hasString(value, 'id') && hasString(value, 'username') && hasString(value, 'role') &&
    (value.teacherId === undefined || typeof value.teacherId === 'string');
}

function getToken(): string | null {
  return getAccessToken();
}

function assistantSessionKey(actor: Pick<AuthUser, 'id' | 'role' | 'teacherId'>): string {
  const scope = [actor.id, actor.role, actor.teacherId ?? ''].join(':');
  return `${ASSISTANT_SESSION_PREFIX}${encodeURIComponent(scope)}`;
}

function readStoredActor(): AuthUser | null {
  try {
    const raw = window.sessionStorage.getItem(ACTOR_SESSION_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !hasString(value, 'id') || !hasString(value, 'username') || !hasString(value, 'role')) return null;
    return { id: value.id as string, username: value.username as string, role: value.role as string, ...(typeof value.teacherId === 'string' ? { teacherId: value.teacherId } : {}) };
  } catch {
    return null;
  }
}

function readAssistantSession(actor: AuthUser | null): PersistedAssistantSession | null {
  if (!actor) return null;
  try {
    const raw = window.sessionStorage.getItem(assistantSessionKey(actor));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.threadId !== 'string' || !Array.isArray(value.messages)) return null;
    const messages = value.messages.filter((message): message is ConversationMessage =>
      isRecord(message) && typeof message.id === 'string' && (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string');
    const parsedWorkspace = isRecord(value.workspace) ? WorkspaceDocumentSchema.safeParse(value.workspace) : null;
    const parsedWorkspaceWithTaskVersion = parsedWorkspace?.success && isRecord(value.workspace) &&
      typeof value.workspace.taskVersion === 'number' && Number.isInteger(value.workspace.taskVersion) && value.workspace.taskVersion >= 0
      ? { ...parsedWorkspace.data, taskVersion: value.workspace.taskVersion } as WorkspaceDocument
      : parsedWorkspace?.success ? parsedWorkspace.data : undefined;
    return {
      threadId: value.threadId,
      messages,
      ...(parsedWorkspaceWithTaskVersion ? { workspace: parsedWorkspaceWithTaskVersion } : {}),
      ...(typeof value.workspaceThreadId === 'string' ? { workspaceThreadId: value.workspaceThreadId } : {}),
      ...(value.requireCorePreviewDisplay === true ? { requireCorePreviewDisplay: true } : {}),
      ...(Array.isArray(value.confirmedPreviewIds) ? { confirmedPreviewIds: value.confirmedPreviewIds.filter((id): id is string => typeof id === 'string') } : {}),
    };
  } catch {
    return null;
  }
}

function writeAssistantSession(actor: AuthUser | null, session: PersistedAssistantSession): void {
  if (!actor) return;
  try {
    window.sessionStorage.setItem(assistantSessionKey(actor), JSON.stringify(session));
  } catch {
    // A full or unavailable sessionStorage must not prevent the AI workspace from working.
  }
}

function newConversation(actor: AuthUser | null): PersistedAssistantSession {
  const stored = readAssistantSession(actor);
  if (stored) return stored;
  return { threadId: createAssistantIds().threadId, messages: [] };
}

function getStablePreviewIdempotencyKey(previewId: string, localKeyRef: { current: string | null }): string | null {
  if (localKeyRef.current && UUID_PATTERN.test(localKeyRef.current)) return localKeyRef.current;
  const storageKey = `${PREVIEW_IDEMPOTENCY_KEY_PREFIX}${previewId}`;
  try {
    const storedKey = window.sessionStorage.getItem(storageKey);
    if (storedKey && UUID_PATTERN.test(storedKey)) {
      localKeyRef.current = storedKey;
      return storedKey;
    }
  } catch {
    // A full or unavailable sessionStorage must not prevent a confirmation attempt.
  }
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') return null;
  const createdKey = crypto.randomUUID();
  localKeyRef.current = createdKey;
  try {
    window.sessionStorage.setItem(storageKey, createdKey);
  } catch {
    // The local ref still keeps retries stable for this mounted preview card.
  }
  return createdKey;
}

async function sendAuthorized(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    return await fetch(path, { ...init, headers });
  } catch {
    // Network failure / backend restarting is NOT an authentication problem.
    throw new ServiceUnavailableError();
  }
}

async function apiRequest<T>(path: string, validate: (value: unknown) => value is T, init?: RequestInit, errorMessages: Partial<Record<number, string>> = {}): Promise<T> {
  let response = await sendAuthorized(path, init);
  if (response.status === 401) {
    const outcome = await refreshSession();
    if (outcome === 'refreshed') {
      response = await sendAuthorized(path, init);
    } else if (outcome === 'expired') {
      notifyAuthExpired();
      throw new SessionExpiredError();
    } else {
      throw new ServiceUnavailableError();
    }
  }
  if (!response.ok) {
    if (response.status === 401) {
      notifyAuthExpired();
      throw new SessionExpiredError();
    }
    if (errorMessages[response.status]) throw new Error(errorMessages[response.status]);
    if (response.status === 403) throw new Error('当前账号无权执行此操作。');
    throw new Error(`请求失败 (${response.status})`);
  }
  const payload: unknown = await response.json();
  if (!validate(payload)) throw new Error('服务返回的数据格式无效');
  return payload;
}


async function getAssistantState(): Promise<AssistantState> {
  return apiRequest('/api/assistant/status', isAssistantState);
}
function useAssistantState() {
  return useQuery({ queryKey: ['assistant-status'], queryFn: getAssistantState, refetchInterval: 10_000 });
}

type OverviewLesson = components['schemas']['DashboardLesson'];
type DashboardOverview = components['schemas']['DashboardOverview'];
type AssistantTaskSummary = { threadId: string; title: string; lastActivityAt: string; latestStatus: string | null };
type AssistantTaskDetail = AssistantTaskSummary & { messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }>; workspace: WorkspaceDocument | null; historicalPreviews: HistoricalPreviewReference[] };
const TASK_HISTORY_ACCESS_MESSAGE = '该任务不存在或当前账号无权访问，请返回任务列表查看。';

function isOverviewLesson(value: unknown): value is OverviewLesson {
  return isRecord(value) && hasString(value, 'id') && hasString(value, 'startsAt') && hasString(value, 'endsAt') && hasString(value, 'status') &&
    isRecord(value.student) && hasString(value.student, 'id') && hasString(value.student, 'name') && isRecord(value.course) && hasString(value.course, 'id') && hasString(value.course, 'name');
}
function isDashboardOverview(value: unknown): value is DashboardOverview {
  if (!isRecord(value) || !hasString(value, 'asOf') || !hasString(value, 'businessDate') || !isRecord(value.today)) return false;
  if (typeof value.today.total !== 'number' || typeof value.today.pendingCount !== 'number' || typeof value.today.completedCount !== 'number' || !Array.isArray(value.today.lessons) || !value.today.lessons.every(isOverviewLesson)) return false;
  const students = value.students === null || (isRecord(value.students) && typeof value.students.total === 'number' && typeof value.students.frozenCount === 'number' && typeof value.students.arrearsCount === 'number');
  const finance = value.finance === null || (isRecord(value.finance) && hasString(value.finance, 'period') && hasString(value.finance, 'operatingProfit') && hasString(value.finance, 'cashNet'));
  const preclose = value.preclose === null || (isRecord(value.preclose) && hasString(value.preclose, 'period') && typeof value.preclose.closed === 'boolean' && typeof value.preclose.unpaidPayrollCount === 'number' && Array.isArray(value.preclose.blockers) && value.preclose.blockers.every((item) => isRecord(item) && hasString(item, 'code') && hasString(item, 'message') && typeof item.count === 'number'));
  const recent = value.recentRecords === null || (Array.isArray(value.recentRecords) && value.recentRecords.every((item) => isRecord(item) && ['id', 'kind', 'occurredAt', 'studentName', 'courseName', 'paidDelta', 'giftDelta'].every((key) => hasString(item, key))));
  return students && finance && preclose && recent;
}
function isTaskSummary(value: unknown): value is AssistantTaskSummary { return isRecord(value) && hasString(value, 'threadId') && hasString(value, 'title') && hasString(value, 'lastActivityAt') && (value.latestStatus === null || typeof value.latestStatus === 'string'); }
function isTaskDetail(value: unknown): value is AssistantTaskDetail { if (!isTaskSummary(value) || !isRecord(value)) return false; const record = value as unknown as Record<string, unknown>; const messages = record['messages']; const historicalPreviews = record['historicalPreviews']; return Array.isArray(messages) && messages.every((message: unknown) => isRecord(message) && hasString(message, 'id') && (message.role === 'user' || message.role === 'assistant') && hasString(message, 'content') && hasString(message, 'createdAt')) && (record['workspace'] === null || WorkspaceDocumentSchema.safeParse(record['workspace']).success) && Array.isArray(historicalPreviews) && historicalPreviews.every((preview: unknown) => HistoricalPreviewReferenceSchema.safeParse(preview).success); }
function overviewMoney(value: string | undefined): string {
  return value ? `¥${value}` : '—';
}
function overviewRecordKind(value: string): string { return ({ PAYMENT: '交费', GIFT: '赠送', LESSON_CONSUMPTION: '课消', LESSON_CONSUMPTION_REVERSAL: '课消冲正', PAYMENT_REVERSAL: '交费冲正', GIFT_REVERSAL: '赠送冲正', REFUND_PAID: '退款', REFUND_GIFT_CLEARING: '赠送清零' } as Record<string, string>)[value] ?? value; }
function useHomeOverview(user: AuthUser | null) {
  return useQuery({ queryKey: ['home-overview', user?.id ?? null, user?.role ?? null, user?.teacherId ?? null], queryFn: () => apiRequest('/api/dashboard/overview', isDashboardOverview), refetchInterval: 30_000 });
}

export function App() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState(() => getToken());
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(() => Boolean(getToken()));
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const clearUserQueryCache = () => {
    void queryClient.cancelQueries();
    queryClient.clear();
  };
  const onLogin = (accessToken: string, refreshToken: string, loggedInUser: AuthUser) => {
    clearUserQueryCache();
    const previousActor = readStoredActor();
    if (previousActor) window.sessionStorage.removeItem(assistantSessionKey(previousActor));
    storeSession(accessToken, refreshToken);
    window.sessionStorage.setItem(ACTOR_SESSION_KEY, JSON.stringify(loggedInUser));
    setAuthNotice(null);
    setToken(accessToken);
    setUser(loggedInUser);
    setAuthChecking(false);
  };
  const onLogout = () => {
    clearUserQueryCache();
    const actor = user ?? readStoredActor();
    revokeSession();
    clearSession();
    if (actor) window.sessionStorage.removeItem(assistantSessionKey(actor));
    window.sessionStorage.removeItem(ACTOR_SESSION_KEY);
    setAuthNotice(null);
    setToken(null);
    setUser(null);
    setAuthChecking(false);
  };
  useEffect(() => {
    let active = true;
    const currentToken = getToken();
    const hasRefreshToken = Boolean(getRefreshToken());
    if (!currentToken && !hasRefreshToken) {
      window.sessionStorage.removeItem(ACTOR_SESSION_KEY);
      setAuthChecking(false);
      return () => { active = false; };
    }
    void apiRequest('/api/auth/me', isAuthUser)
      .then((currentActor) => {
        if (!active) return;
        window.sessionStorage.setItem(ACTOR_SESSION_KEY, JSON.stringify(currentActor));
        setAuthNotice(null);
        setUser(currentActor);
        setAuthChecking(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        // Only an explicit 401 ends the session. A backend restart or network
        // blip must not wipe stored credentials and kick the user out.
        if (error instanceof SessionExpiredError) {
          clearUserQueryCache();
          clearSession();
          window.sessionStorage.removeItem(ACTOR_SESSION_KEY);
          setToken(null);
          setUser(null);
        } else {
          setUser(readStoredActor());
          setAuthNotice('服务暂时不可用，请稍后重试；你的登录状态已保留。');
        }
        setAuthChecking(false);
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const handleAuthExpired = () => onLogout();
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  });

  if (!token) return <LoginPage notice={authNotice} onLogin={onLogin} />;
  if (authChecking) return <main className="login-screen"><p role="status">正在验证登录状态…</p></main>;
  if (!user) return <main className="login-screen"><p role="status">{authNotice ?? '正在验证登录状态…'}</p><Button onClick={() => window.location.reload()}>重新加载</Button></main>;
  return (
    <Routes>
      <Route element={<WorkspaceLayout onLogout={onLogout} user={user} />} path="/">
        <Route element={<WorkspaceHome />} index />
        <Route element={<OwnerOnlyPage user={user}><StructuredBusinessPage section="students" /></OwnerOnlyPage>} path="students" />
        <Route element={<StructuredBusinessPage section="schedule" />} path="schedule" />
        <Route element={<OwnerOnlyPage user={user}><StructuredBusinessPage section="finance" /></OwnerOnlyPage>} path="finance" />
        <Route element={<OwnerOnlyPage user={user}><StructuredBusinessPage section="settings" /></OwnerOnlyPage>} path="settings" />
        <Route element={<TaskHistoryPage />} path="tasks/:threadId" />
        <Route element={<OwnerOnlyPage user={user}><StructuredBusinessPage section="students" /></OwnerOnlyPage>} path="structured/students" />
        <Route element={<StructuredBusinessPage section="schedule" />} path="structured/schedule" />
        <Route element={<OwnerOnlyPage user={user}><StructuredBusinessPage section="finance" /></OwnerOnlyPage>} path="structured/finance" />
      </Route>
      <Route element={<WorkspaceLayout onLogout={onLogout} user={user} />} path="*">
        <Route element={<WorkspaceHome />} index />
      </Route>
    </Routes>
  );
}

function OwnerOnlyPage({ children, user }: { children: ReactNode; user: AuthUser }) {
  if (user.role === 'OWNER') return <>{children}</>;
  return <section aria-labelledby="role-denied-heading" className="structured-view"><Alert message="当前账号无权访问该页面" description="老师只能查看自己的工作台和排课信息。" showIcon type="warning" /></section>;
}

function TaskHistoryPage() {
  const { threadId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useOutletContext<{ user: AuthUser | null }>();
  const task = useQuery({
    queryKey: ['assistant-task', user?.id, user?.role, user?.teacherId ?? null, threadId],
    queryFn: () => apiRequest(`/api/assistant/tasks/${encodeURIComponent(threadId)}`, isTaskDetail, undefined, { 403: TASK_HISTORY_ACCESS_MESSAGE, 404: TASK_HISTORY_ACCESS_MESSAGE }),
    enabled: Boolean(user) && UUID_PATTERN.test(threadId),
  });
  const invalidateHomeAfterConfirmation = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['home-overview'] });
    void queryClient.invalidateQueries({ queryKey: ['assistant-tasks'] });
  }, [queryClient]);
  const workspace = task.data?.workspace;
  const workspaceForRecovery = workspace?.blocks.some((block) => block.type === 'action-preview')
    ? { ...workspace, blocks: workspace.blocks.filter((block) => block.type === 'action-preview') }
    : workspace;
  const currentWorkspacePreviewIds = new Set(workspace?.blocks.flatMap((block) => block.type === 'action-preview' ? [block.previewId] : []) ?? []);
  const historicalPreviews = task.data?.historicalPreviews.filter((preview, index, all) => all.findIndex((candidate) => candidate.previewId === preview.previewId) === index) ?? [];
  return <section className="task-history-page">
    <div className="task-history-head"><div><span className="eyebrow accent-eyebrow">PERSISTED TASK</span><Title level={1}>{task.data?.title ?? '任务详情'}</Title><p>消息和确认单按当前登录身份重新读取；执行状态与回执以系统当前记录为准。</p></div><div className="task-history-actions"><Button onClick={() => navigate('/')}>返回工作台</Button><Button disabled={!task.data} onClick={() => { if (!task.data) return; writeAssistantSession(user, { threadId: task.data.threadId, messages: task.data.messages.map((message) => ({ id: message.id, role: message.role, text: message.content })), ...(workspaceForRecovery ? { workspace: workspaceForRecovery, workspaceThreadId: task.data.threadId, requireCorePreviewDisplay: true } : {}) }); navigate('/'); }} type="primary">继续此任务</Button></div></div>
    {task.isLoading ? <div className="loading-state">正在读取任务…</div> : task.isError ? <Alert message="暂时无法读取任务" description={task.error.message} type="error" showIcon /> : <>
      {task.data && <div className="task-transcript">{task.data.messages.map((message) => <article className={`task-message ${message.role}`} key={message.id}><header><strong>{message.role === 'user' ? '你' : 'AI 助手'}</strong><time>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(message.createdAt))}</time></header><p>{formatAssistantReply(message.content)}</p></article>)}</div>}
      <section aria-label="历史确认单列表" className="task-history-workspace">
        {historicalPreviews.length ? historicalPreviews.map((preview, index) => <div className="task-history-preview-step" key={preview.previewId}>
          <span className="eyebrow">第 {index + 1} 步</span>
          <PreviewConfirmationCard confirmAllowed={currentWorkspacePreviewIds.has(preview.previewId)} interactionDisabled={false} key={preview.previewId} onConfirmed={invalidateHomeAfterConfirmation} preview={{ type: 'action-preview', ...preview, title: `第 ${index + 1} 步确认单` }} previewRecheckVersion={0} requireCoreDisplay />
        </div>) : <p className="workspace-empty">此任务没有已保存的确认单。</p>}
      </section>
    </>}
  </section>;
}

function StructuredBusinessPage({ section }: { section: 'students' | 'schedule' | 'finance' | 'settings' }) {
  const { assistantState, user } = useOutletContext<{ assistantState: ReturnType<typeof useAssistantState>; user: AuthUser | null }>();
  const [resultTarget, setResultTarget] = useState<HTMLDivElement | null>(null);
  const [showResult, setShowResult] = useState(false);
  return <section className={`business-page business-page-${section}`}>
    <AssistantCompanion assistantState={assistantState} section={section} user={user} resultTarget={resultTarget} onShowResult={() => setShowResult(true)} />
    <div aria-label="业务工作区" className="business-workspace panel-surface"><div hidden={showResult}><StructuredWorkbench section={section} role={user?.role ?? ''} /></div><div hidden={!showResult} ref={setResultTarget} /><div hidden={!showResult} className="business-result-actions"><Button onClick={() => setShowResult(false)}>返回业务功能</Button></div></div>
  </section>;
}

const pageAssistantCopy = {
  students: { title: '学生与账户', welcome: '你可以按姓名或联系电话查学生，也可以让我协助办理交费、赠送、退款或课程改价。所有资金变更都会先生成确认单。', suggestions: ['查找学生账户', '查看冻结学生', '办理学生交费'] },
  schedule: { title: '排课与课消', welcome: '你可以查询任意日期的排课，也可以让我协助排课、调课、取消或确认上课。', suggestions: ['查看今天排课', '查看明天排课', '调整上课时间'] },
  finance: { title: '收支与报表', welcome: '经营结果和现金收支会分开说明。你也可以办理工资、手工收支和关账。', suggestions: ['查看本月经营利润', '查看这个月收入', '检查能否关账'] },
  settings: { title: '教师与课程', welcome: '在这里维护教师资料、默认薪酬和课程信息，也可以告诉我你想要办理的事项。', suggestions: ['查看教师', '查看课程', '新增课程'] },
} as const;

function AssistantCompanion({ assistantState, section, user, resultTarget, onShowResult }: { assistantState: ReturnType<typeof useAssistantState>; section: keyof typeof pageAssistantCopy; user: AuthUser | null; resultTarget: HTMLDivElement | null; onShowResult: () => void }) {
  const copy = pageAssistantCopy[section];
  const queryClient = useQueryClient();
  const initialRef = useRef<PersistedAssistantSession | null>(null);
  if (!initialRef.current) initialRef.current = newConversation(user);
  const [threadId] = useState(() => initialRef.current?.threadId ?? createAssistantIds().threadId);
  const [messages, setMessages] = useState<ConversationMessage[]>(() => initialRef.current?.messages ?? []);
  const [prompt, setPrompt] = useState('');
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'waiting' | 'done' | 'failed'>('idle');
  const [workspace, setWorkspace] = useState<WorkspaceDocument | undefined>(() => initialRef.current?.workspace);
  const [workspaceThreadId, setWorkspaceThreadId] = useState(() => initialRef.current?.workspaceThreadId ?? threadId);
  const [previewRecheckVersion, setPreviewRecheckVersion] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    writeAssistantSession(user, { threadId, messages, ...(workspace ? { workspace, workspaceThreadId } : {}) });
  }, [messages, threadId, user, workspace, workspaceThreadId]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const append = (role: ConversationMessage['role'], text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((current) => [...current, { id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, role, text: trimmed }]);
  };
  const send = async (text: string) => {
    const message = text.trim();
    if (!message || status === 'running') return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    append('user', message);
    setPrompt(''); setReply(''); setStatus('running');
    let streamedReply = '';
    try {
      const { clientRequestId } = createAssistantIds();
      const run = await startAssistantRun({ token: getToken(), message, threadId, clientRequestId });
      await streamAssistantEvents({ token: getToken(), run, signal: controller.signal, onEvent: (event) => {
        if (event.type === 'assistant.delta') { streamedReply += event.text; setReply(streamedReply); }
        if (event.type === 'assistant.message') { streamedReply = event.markdown; setReply(streamedReply); }
        if (event.type === 'workspace.replace') { setWorkspace(event.document); setWorkspaceThreadId(threadId); onShowResult(); }
        if (event.type === 'clarification.requested') { append('assistant', event.question); streamedReply = ''; setReply(''); setStatus('waiting'); return true; }
        if (event.type === 'run.failed') { append('assistant', event.message); streamedReply = ''; setReply(''); setStatus('failed'); return true; }
        if (event.type === 'run.completed') { if (streamedReply) append('assistant', streamedReply); streamedReply = ''; setReply(''); setStatus('done'); return true; }
        return false;
      } });
    } catch (error) {
      if (!controller.signal.aborted) { append('assistant', error instanceof Error ? error.message : '暂时无法连接助手。'); setStatus('failed'); setPreviewRecheckVersion((current) => current + 1); }
    }
  };
  const selectCandidate = (candidateId: string, taskVersion?: number) => {
    if (status === 'running' || workspaceThreadId !== threadId || !workspace?.blocks.some((block) => block.type === 'entity-picker' && block.candidates.some((candidate) => candidate.id === candidateId))) return;
    void send(`选择候选:${candidateId}${typeof taskVersion === 'number' ? `:${taskVersion}` : ''}`);
  };
  const recoverWorkspace = (action: RecoveryAction) => {
    if (status !== 'running') void send(action === 'refresh' ? '刷新当前结果' : '重新生成预览');
  };
  const visibleMessages = messages.slice(-8);
  return <section aria-label={`${copy.title}经营助手`} className="page-assistant panel-surface">
    <div className="page-assistant-head"><div><span className="eyebrow">AI OPERATING ASSISTANT</span><Title level={2}>{copy.title}</Title><p>对话、补充信息、确认和结果都在这里连续呈现</p></div><span className={`assistant-availability ${assistantState.data?.available ? 'is-online' : ''}`}>{assistantState.data?.available ? '在线' : '暂不可用'}</span></div>
    <div className="page-chat-stream"><div className="chat-message assistant"><span className="chat-avatar">AI</span><p>{copy.welcome}</p></div>{visibleMessages.map((message) => <div className={`chat-message ${message.role}`} key={message.id}><span className="chat-avatar">{message.role === 'user' ? (user?.username.slice(0, 1).toUpperCase() || '你') : 'AI'}</span><p>{formatAssistantReply(message.text)}</p></div>)}{reply && <div className="chat-message assistant"><span className="chat-avatar">AI</span><p>{formatAssistantReply(reply)}</p></div>}</div>
    {workspace && <button className="workspace-result-link" onClick={onShowResult} type="button">查看本次对话结果 →</button>}
    {workspace && resultTarget && createPortal(<section aria-label="AI 工作区结果" className="business-ai-workspace"><div className="context-heading"><div><span className="eyebrow">CURRENT TASK</span><Title level={3}>本次对话结果</Title></div></div><WorkspaceContent document={workspace} interactionDisabled={status === 'running' || workspaceThreadId !== threadId} isCurrentWorkspace={workspaceThreadId === threadId} onCandidateSelect={selectCandidate} onPreviewConfirmed={() => { void queryClient.invalidateQueries(); }} onRecoveryAction={recoverWorkspace} previewRecheckVersion={previewRecheckVersion} /></section>, resultTarget)}
    <div className="page-chat-composer"><div className="page-quick-prompts">{copy.suggestions.map((item) => <button disabled={status === 'running'} key={item} onClick={() => setPrompt(item)} type="button">{item}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); void send(prompt); }}><TextArea aria-label={`${copy.title}经营问题`} autoSize={{ minRows: 2, maxRows: 4 }} disabled={status === 'running'} onChange={(event) => setPrompt(event.target.value)} placeholder="直接描述你想查询或办理的事情…" value={prompt} /><Button disabled={!prompt.trim() || status === 'running'} htmlType="submit" type="primary">{status === 'running' ? '处理中…' : '发送 ↑'}</Button></form></div>
  </section>;
}

function LoginPage({ onLogin, notice }: { onLogin: (token: string, refreshToken: string, user: AuthUser) => void; notice?: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) throw new Error('用户名或密码不正确');
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !hasString(payload, 'accessToken') || !isRecord(payload.user) ||
          !hasString(payload.user, 'id') || !hasString(payload.user, 'username') || !hasString(payload.user, 'role')) {
        throw new Error('登录响应格式无效');
      }
      const loginPayload = payload as { accessToken: string; refreshToken?: unknown; user: Record<string, unknown> };
      onLogin(loginPayload.accessToken, typeof loginPayload.refreshToken === 'string' ? loginPayload.refreshToken : '', {
        id: loginPayload.user.id as string,
        username: loginPayload.user.username as string,
        role: loginPayload.user.role as string,
        ...(typeof loginPayload.user.teacherId === 'string' ? { teacherId: loginPayload.user.teacherId } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };
  return (
    <main className="login-screen">
      <Card className="login-card" variant="borderless">
        <Link aria-label="琴行经营" className="brand login-brand" to="/">
          <span className="brand-mark">P</span><span><strong>琴行经营</strong><small>AI 工作台</small></span>
        </Link>
        <span className="eyebrow accent-eyebrow">SECURE SIGN IN</span>
        <Title level={1}>登录工作台</Title>
        <p className="intro-copy">使用琴行管理账号查看真实业务数据。</p>
        {error && <Alert className="login-error" type="error" showIcon message={error} />}
        {!error && notice && <Alert className="login-error" type="warning" showIcon message={notice} />}
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="username">用户名</label>
          <Input autoComplete="username" id="username" onChange={(event) => setUsername(event.target.value)} required value={username} />
          <label htmlFor="password">密码</label>
          <Input.Password autoComplete="current-password" id="password" onChange={(event) => setPassword(event.target.value)} required value={password} />
          <Button block htmlType="submit" loading={loading} type="primary">登录</Button>
        </form>
      </Card>
    </main>
  );
}

function WorkspaceLayout({ onLogout, user }: { onLogout: () => void; user: AuthUser | null }) {
  const [workspace, setWorkspaceState] = useState<WorkspaceState | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [workspaceInteractionDisabled, setWorkspaceInteractionDisabled] = useState(false);
  const [previewRecheckVersion, setPreviewRecheckVersion] = useState(0);
  const candidateSelectionRef = useRef<CandidateSelectionHandler | null>(null);
  const clearConversationRef = useRef<ClearConversationHandler | null>(null);
  const previewConfirmationRef = useRef<PreviewConfirmationHandler | null>(null);
  const recoveryActionRef = useRef<RecoveryActionHandler | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const assistantState = useAssistantState();
  const isAssistantWorkspace = location.pathname === '/';
  const normalizedPath = location.pathname.replace(/^\/structured/, '') || '/';
  const setWorkspace = useCallback((document: WorkspaceDocument | null, threadId?: string, requireCoreDisplay = false) => {
    setWorkspaceState(document && threadId ? { document, threadId, ...(requireCoreDisplay ? { requireCoreDisplay: true } : {}) } : null);
  }, []);
  const registerCandidateSelection = useCallback((handler: CandidateSelectionHandler) => {
    candidateSelectionRef.current = handler;
    return () => {
      if (candidateSelectionRef.current === handler) candidateSelectionRef.current = null;
    };
  }, []);
  const registerClearConversation = useCallback((handler: ClearConversationHandler) => {
    clearConversationRef.current = handler;
    return () => {
      if (clearConversationRef.current === handler) clearConversationRef.current = null;
    };
  }, []);
  const registerPreviewConfirmation = useCallback((handler: PreviewConfirmationHandler) => {
    previewConfirmationRef.current = handler;
    return () => {
      if (previewConfirmationRef.current === handler) previewConfirmationRef.current = null;
    };
  }, []);
  const registerRecoveryAction = useCallback((handler: RecoveryActionHandler) => {
    recoveryActionRef.current = handler;
    return () => {
      if (recoveryActionRef.current === handler) recoveryActionRef.current = null;
    };
  }, []);
  return (
    <div className="app-shell">
      <div className="prototype-strip"><span>AI NATIVE · 经营工作台</span><span>重要操作先确认，再执行</span></div>
      <div className={`workspace-grid ${isAssistantWorkspace ? 'assistant-layout' : 'structured-layout'}`}>
        <aside aria-label="主导航" className="sidebar panel-surface">
          <Link aria-label="返回 AI 工作台" className="brand sidebar-brand" to="/">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span><strong>琴行经营</strong><small>AI 经营中枢</small></span>
          </Link>
          <div className="sidebar-heading"><span className="eyebrow">经营导航</span><span className="sidebar-caption">OPERATING</span></div>
          <nav className="nav-list">
            {(user?.role === 'TEACHER' ? navItems.filter((item) => item.path === '/' || item.path === '/schedule') : navItems).map((item) => {
              const active = normalizedPath === item.path;
              return <button className={`nav-item ${active ? 'is-active' : ''}`} key={item.path} onClick={() => navigate(item.path)} type="button">
                <span className="nav-icon" aria-hidden="true"><NavIcon name={item.icon} /></span><span className="nav-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
                {active && <span className="nav-active-mark" />}
              </button>;
            })}
          </nav>
          <div className="sidebar-footer">
            <div><span className="eyebrow">当前账号</span><strong>{user?.username ?? '已登录'}</strong></div>
            <Button aria-label="退出登录" ghost onClick={onLogout} size="small">退出</Button>
          </div>
        </aside>
        <main className="main-column"><Outlet context={{ assistantState, onLogout, user, setWorkspace, setActiveThreadId, setWorkspaceInteractionDisabled, setPreviewRecheckVersion, registerCandidateSelection, registerClearConversation, registerPreviewConfirmation, registerRecoveryAction }} /></main>
        {isAssistantWorkspace && <aside aria-label="经营工作区" className="context-panel panel-surface"><ContextPanel
          activeThreadId={activeThreadId}
          interactionDisabled={workspaceInteractionDisabled}
          onCandidateSelect={(candidateId, taskVersion) => candidateSelectionRef.current?.(candidateId, taskVersion)}
          onClear={() => clearConversationRef.current?.()}
          onPreviewConfirmed={(previewId) => previewConfirmationRef.current?.(previewId)}
          onRecoveryAction={(action) => recoveryActionRef.current?.(action)}
          previewRecheckVersion={previewRecheckVersion}
          user={user}
          workspace={workspace}
        /></aside>}
      </div>
    </div>
  );
}

function NavIcon({ name }: { name: NavIconName }) {
  if (name === 'home') return <svg viewBox="0 0 24 24"><path d="M4 13.5 12 6l8 7.5" /><path d="M7 11.5V20h10v-8.5" /></svg>;
  if (name === 'students') return <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3" /><path d="M6 20c.7-4 2.7-6 6-6s5.3 2 6 6" /></svg>;
  if (name === 'schedule') return <svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="14" rx="2" /><path d="M8 3v6M16 3v6M4 11h16" /></svg>;
  if (name === 'settings') return <svg viewBox="0 0 24 24"><path d="M5 5h14v14H5zM9 5v14M14 9h2M14 13h2" /></svg>;
  return <svg viewBox="0 0 24 24"><path d="M5 20V10M12 20V4M19 20v-7" /><path d="M3 20h18" /></svg>;
}

function WorkspaceHome() {
  const [prompt, setPrompt] = useState('');
  const [runStatus, setRunStatus] = useState<AssistantRunStatus | 'idle' | 'connecting' | 'connection_failed'>('idle');
  const [runId, setRunId] = useState('');
  const [reply, setReply] = useState('');
  const [clarification, setClarification] = useState('');
  const [runError, setRunError] = useState('');
  const { assistantState, onLogout, user, setWorkspace, setActiveThreadId, setWorkspaceInteractionDisabled, setPreviewRecheckVersion, registerCandidateSelection, registerClearConversation, registerPreviewConfirmation, registerRecoveryAction } = useOutletContext<{
    assistantState: ReturnType<typeof useAssistantState>;
    onLogout: () => void;
    user: AuthUser | null;
    setWorkspace: (workspace: WorkspaceDocument | null, threadId?: string, requireCoreDisplay?: boolean) => void;
    setActiveThreadId: (threadId: string | null) => void;
    setWorkspaceInteractionDisabled: (disabled: boolean) => void;
    setPreviewRecheckVersion: (update: (current: number) => number) => void;
    registerCandidateSelection: (handler: CandidateSelectionHandler) => () => void;
    registerClearConversation: (handler: ClearConversationHandler) => () => void;
    registerPreviewConfirmation: (handler: PreviewConfirmationHandler) => () => void;
    registerRecoveryAction: (handler: RecoveryActionHandler) => () => void;
  }>();
  const initialSessionRef = useRef<PersistedAssistantSession | null>(null);
  if (!initialSessionRef.current) initialSessionRef.current = newConversation(user);
  const [threadId, setThreadId] = useState(() => initialSessionRef.current?.threadId ?? createAssistantIds().threadId);
  const [messages, setMessages] = useState<ConversationMessage[]>(() => initialSessionRef.current?.messages ?? []);
  const [workspace, setLocalWorkspace] = useState<WorkspaceDocument | null>(() => initialSessionRef.current?.workspace ?? null);
  const [workspaceThreadId, setWorkspaceThreadId] = useState(() => initialSessionRef.current?.workspaceThreadId ?? initialSessionRef.current?.threadId ?? threadId);
  const [requireCorePreviewDisplay, setRequireCorePreviewDisplay] = useState(() => initialSessionRef.current?.requireCorePreviewDisplay === true);
  const [confirmedPreviewIds, setConfirmedPreviewIds] = useState<Set<string>>(() => new Set(initialSessionRef.current?.confirmedPreviewIds ?? []));
  const controllerRef = useRef<AbortController | null>(null);
  const replyRef = useRef('');
  const clearingRef = useRef(false);
  const isUnavailable = assistantState.isError || !assistantState.data?.available;
  const isBusy = runStatus === 'connecting' || runStatus === 'queued' || runStatus === 'running';
  useEffect(() => {
    setWorkspaceInteractionDisabled(isBusy);
    return () => setWorkspaceInteractionDisabled(false);
  }, [isBusy, setWorkspaceInteractionDisabled]);
  useEffect(() => {
    setActiveThreadId(threadId);
    if (workspace) setWorkspace(workspace, workspaceThreadId, requireCorePreviewDisplay);
    return () => setActiveThreadId(null);
  }, [requireCorePreviewDisplay, setActiveThreadId, setWorkspace, threadId, workspace, workspaceThreadId]);

  useEffect(() => {
    writeAssistantSession(user, {
      threadId,
      messages,
      ...(workspace ? { workspace, workspaceThreadId } : {}),
      ...(requireCorePreviewDisplay ? { requireCorePreviewDisplay: true } : {}),
      ...(confirmedPreviewIds.size > 0 ? { confirmedPreviewIds: [...confirmedPreviewIds] } : {}),
    });
  }, [confirmedPreviewIds, messages, requireCorePreviewDisplay, threadId, user, workspace, workspaceThreadId]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const appendMessage = (role: ConversationMessage['role'], text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    setMessages((current) => [...current, { id, role, text: trimmed }]);
  };

  const updateReply = (next: string) => {
    replyRef.current = next;
    setReply(next);
  };

  const receiveWorkspace = (document: WorkspaceDocument) => {
    setLocalWorkspace(document);
    setWorkspaceThreadId(threadId);
    setWorkspace(document, threadId, requireCorePreviewDisplay);
  };

  const handleEvent = (event: AssistantUiEvent): boolean => {
    switch (event.type) {
      case 'assistant.delta':
        updateReply(replyRef.current + event.text);
        break;
      case 'assistant.message':
        updateReply(event.markdown);
        break;
      case 'workspace.replace':
        receiveWorkspace(event.document);
        break;
      case 'clarification.requested':
        if (replyRef.current) appendMessage('assistant', replyRef.current);
        updateReply('');
        appendMessage('assistant', event.question);
        setClarification(event.question);
        setRunStatus('waiting_for_input');
        return true;
      case 'run.completed':
        if (replyRef.current) appendMessage('assistant', replyRef.current);
        updateReply('');
        setRunStatus('completed');
        return true;
      case 'run.failed':
        if (replyRef.current) appendMessage('assistant', replyRef.current);
        updateReply('');
        setRunStatus('failed');
        setRunError(event.message);
        return true;
      default:
        break;
    }
    return false;
  };

  const submitMessage = async (message: string, force = false): Promise<boolean> => {
    const normalizedMessage = message.trim();
    if (!normalizedMessage || (!force && isBusy)) return false;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    appendMessage('user', normalizedMessage);
    setPrompt('');
    setRunStatus('connecting');
    setRunId('');
    updateReply('');
    setClarification('');
    setRunError('');
    try {
      const { clientRequestId } = createAssistantIds();
      const run = await startAssistantRun({ token: getToken(), message: normalizedMessage, threadId, clientRequestId });
      setRunId(run.runId);
      setRunStatus(run.status);
      if (run.status === 'completed' || run.status === 'failed') setRunStatus('running');
      let receivedFinalEvent = false;
      let hasErrorRecovery = false;
      let completedSuccessfully = false;
      await streamAssistantEvents({
        token: getToken(),
        run,
        signal: controller.signal,
        onEvent: (assistantEvent) => {
          if (isTerminalAssistantEvent(assistantEvent) || assistantEvent.type === 'clarification.requested') receivedFinalEvent = true;
          if (assistantEvent.type === 'workspace.replace' && assistantEvent.document.blocks.some((block) => block.type === 'error-recovery')) hasErrorRecovery = true;
          if (assistantEvent.type === 'run.completed') completedSuccessfully = true;
          return handleEvent(assistantEvent);
        },
      });
      if (!receivedFinalEvent && !controller.signal.aborted) {
        setRunStatus('connection_failed');
        setRunError('事件连接已结束，但运行没有返回完成状态。可以稍后重试。');
        setPreviewRecheckVersion((current) => current + 1);
        return false;
      }
      return completedSuccessfully && !hasErrorRecovery;
    } catch (cause) {
      if (controller.signal.aborted) return false;
      setRunStatus('connection_failed');
      setRunError(cause instanceof Error ? cause.message : '无法连接 AI 助手，请检查网络后重试。');
      setPreviewRecheckVersion((current) => current + 1);
      return false;
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitMessage(prompt);
  };

  useEffect(() => registerCandidateSelection((candidateId) => {
    if (isBusy || !workspace || workspaceThreadId !== threadId) return;
    const candidate = workspace.blocks.find((block) => block.type === 'entity-picker' && block.candidates.some((item) => item.id === candidateId));
    if (!candidate || candidate.type !== 'entity-picker') return;
    const currentTaskVersion = (workspace as WorkspaceWithTaskVersion).taskVersion;
    const suffix = typeof currentTaskVersion === 'number' ? `:${currentTaskVersion}` : '';
    void submitMessage(`选择候选:${candidateId}${suffix}`);
  }), [isBusy, registerCandidateSelection, submitMessage, threadId, workspace, workspaceThreadId]);

  useEffect(() => registerPreviewConfirmation((previewId) => {
    setConfirmedPreviewIds((current) => {
      const next = new Set(current);
      next.add(previewId);
      return next;
    });
  }), [registerPreviewConfirmation]);

  useEffect(() => registerRecoveryAction((action) => {
    if (isBusy) return;
    void submitMessage(action === 'refresh' ? '刷新当前结果' : '重新生成预览');
  }), [isBusy, registerRecoveryAction, submitMessage]);

  const resetConversation = () => {
    const newThreadId = createAssistantIds().threadId;
    setThreadId(newThreadId);
    setMessages([]);
    setLocalWorkspace(null);
    setWorkspaceThreadId(newThreadId);
    setRequireCorePreviewDisplay(false);
    setConfirmedPreviewIds(new Set());
    setWorkspace(null);
    setRunStatus('idle');
    setRunId('');
    updateReply('');
    setClarification('');
    setRunError('');
    setPrompt('');
    setWorkspaceInteractionDisabled(false);
    setActiveThreadId(newThreadId);
  };

  useEffect(() => registerClearConversation(() => {
    if (clearingRef.current) return;
    const pendingPreview = workspace?.blocks.some((block) => block.type === 'action-preview' && !confirmedPreviewIds.has(block.previewId)) ?? false;
    if (!pendingPreview) {
      controllerRef.current?.abort();
      resetConversation();
      return;
    }
    clearingRef.current = true;
    void submitMessage('取消当前办理', true).then((cancelled) => {
      if (cancelled) resetConversation();
      clearingRef.current = false;
    });
  }), [confirmedPreviewIds, registerClearConversation, setActiveThreadId, setWorkspace, submitMessage, workspace]);

  const statusLabel: Record<typeof runStatus, string> = {
    idle: '尚未开始', connecting: '正在连接', queued: '排队中', running: '运行中',
    waiting_for_input: '等待补充信息', completed: '回复已生成', failed: '运行失败', connection_failed: '连接失败',
  };
  return (
    <section aria-labelledby="welcome-heading" className="home-view">
      <div className="home-intro"><div><span className="eyebrow accent-eyebrow">AI-FIRST OPERATING DESK</span><Title id="welcome-heading" level={1}>把经营问题交给工作台。</Title>
        <p className="intro-copy">今天先处理什么？用自然语言描述目标，查询结果和待确认操作都会在同一处连续呈现。</p></div>
        <div className="date-chip"><span className="date-label">业务日</span><strong>尚未设置</strong></div></div>
      {isUnavailable && <Alert className="availability-alert" description={user?.role === 'TEACHER' ? '助手暂时无法回答问题，你仍可以使用排课页面。' : '助手暂时无法回答问题，你仍可以使用学生、排课和收支页面。'} title="助手暂时不可用" showIcon type="warning" />}
      <Card className="prompt-card" variant="borderless">
        <div className="card-heading"><div><span className="eyebrow">OPERATING THREAD</span><Title level={3}>今天先处理什么？</Title></div><span className={`assistant-availability ${isUnavailable ? '' : 'is-online'}`}>{isUnavailable ? '暂不可用' : '在线'}</span></div>
        <section aria-label="对话历史" className="conversation-history home-conversation">
          {messages.length === 0 && <div className="conversation-message conversation-message-assistant welcome-message"><span className="chat-avatar">AI</span><div><strong>AI 助手</strong><p>{user?.role === 'TEACHER' ? '早上好。你可以查看自己的课表，办理调课、请假或确认上课。' : '早上好。你可以直接查询今天的排课、本月经营情况，或办理学生账户和日常经营事项。'}</p></div></div>}
          {messages.map((message) => <div className={`conversation-message conversation-message-${message.role}`} key={message.id}>
            <span className="chat-avatar">{message.role === 'user' ? (user?.username.slice(0, 1).toUpperCase() || '你') : 'AI'}</span><div><strong>{message.role === 'user' ? '你' : 'AI 助手'}</strong><p>{formatAssistantReply(message.text)}</p></div>
          </div>)}
          {reply && <div className="conversation-message conversation-message-assistant"><span className="chat-avatar">AI</span><div><strong>AI 助手</strong><p aria-live="polite">{formatAssistantReply(reply)}</p></div></div>}
        </section>
        <div className="suggestion-row" aria-label="示例入口"><span className="suggestion-label">可以从这里开始</span>{(user?.role === 'TEACHER' ? ['查看今日排课', '查看明天排课', '查看我的课程业绩'] : suggestions).map((suggestion) => <button className="suggestion-button" disabled={isBusy} key={suggestion} onClick={() => setPrompt(suggestion)} type="button">{suggestion}</button>)}</div>
        <form onSubmit={submit}>
          <TextArea aria-label="经营问题" autoSize={{ minRows: 2, maxRows: 4 }} disabled={isBusy} onChange={(event) => setPrompt(event.target.value)} placeholder="直接描述你想查询或办理的事情…" value={prompt} />
          <div className="prompt-footer"><Text className="prompt-hint">{isUnavailable ? 'AI 服务当前不可用，提交后会显示连接结果。' : '消息将发送给 AI 助手；写入操作仍须由你确认。'}</Text><div className="prompt-actions">{isBusy && <Button onClick={() => void submitMessage('取消当前办理', true)} size="small">取消当前办理</Button>}<Button disabled={prompt.trim().length === 0 || isBusy} loading={runStatus === 'connecting'} htmlType="submit" type="primary">{isBusy ? '处理中…' : '发送消息'} <span aria-hidden="true">↗</span></Button></div></div>
        </form>
        {runStatus !== 'idle' && <section aria-label="AI 运行结果" className={`assistant-run assistant-run-${runStatus}`}>
          <div className="assistant-run-heading"><strong>本轮状态</strong><Tag>{statusLabel[runStatus]}</Tag>{runId && <Text className="run-id">Run {runId}</Text>}</div>
          {clarification && <Alert className="run-alert" message="需要补充信息" description={clarification} showIcon type="info" />}
          {runError && <Alert className="run-alert" message={runError} showIcon type="error" action={runError.includes('登录状态已失效') ? <Button onClick={onLogout} size="small">返回登录</Button> : undefined} />}
        </section>}
      </Card>
      <section aria-labelledby="workflow-heading" className="workflow-section"><div className="section-heading"><div><span className="eyebrow">SAFE WORKFLOW</span><Title id="workflow-heading" level={3}>每一次操作都经过确认</Title></div><Text className="section-note">AI 先理解，再由你决定</Text></div>
        <div className="workflow-steps"><WorkflowStep number="01" title="描述" detail="用自然语言说明目标" /><span className="step-arrow" aria-hidden="true">→</span><WorkflowStep number="02" title="预览" detail="查看数据与计算依据" /><span className="step-arrow" aria-hidden="true">→</span><WorkflowStep number="03" title="确认" detail="你确认后才执行写入" /></div>
      </section>
    </section>
  );
}

function HomeOverview({ user, overview }: { user: AuthUser | null; overview: ReturnType<typeof useHomeOverview> }) {
  const navigate = useNavigate();
  const tasks = useQuery({ queryKey: ['assistant-tasks', user?.id ?? null, user?.role ?? null, user?.teacherId ?? null], queryFn: () => apiRequest('/api/assistant/tasks', (value): value is AssistantTaskSummary[] => Array.isArray(value) && value.every(isTaskSummary)), refetchInterval: 30_000 });
  const isOwner = user?.role === 'OWNER';
  const lessons = overview.data?.today.lessons ?? [];
  const pendingCount = overview.data?.today.pendingCount ?? 0;
  const frozenStudents = overview.data?.students?.frozenCount;
  const blockers = overview.data?.preclose?.blockers ?? [];
  const todayLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  return <section aria-labelledby="overview-heading" className="home-overview">
    <div className="overview-heading"><div><span className="eyebrow">OPERATING SNAPSHOT</span><Title id="overview-heading" level={3}>经营概览</Title><p>查看当前业务情况，及时处理待办事项。</p></div><span className="overview-date">{todayLabel}</span></div>
    <div className="overview-metrics">
      <OverviewMetric label="待确认课消" value={overview.isLoading ? '…' : overview.isError ? '暂不可用' : String(pendingCount)} hint={overview.isError ? '请稍后重试' : pendingCount ? '存在已结束但未确认课程' : '今天没有待处理课消'} tone={pendingCount ? 'warning' : 'neutral'} />
      <OverviewMetric label="冻结学生" value={overview.isLoading ? '…' : overview.isError ? '暂不可用' : isOwner ? String(frozenStudents ?? 0) : '仅店主可见'} hint={isOwner ? '来自学生学籍状态' : '当前账号没有学生资料权限'} tone={frozenStudents ? 'warning' : 'neutral'} />
      <OverviewMetric label="本月经营利润" value={overview.isLoading ? '…' : overview.isError ? '暂不可用' : isOwner ? overviewMoney(overview.data?.finance?.operatingProfit) : '仅店主可见'} hint={isOwner ? '按业务月份统计' : '当前账号没有报表权限'} tone="positive" />
      <OverviewMetric label="关账状态" value={overview.isLoading ? '…' : overview.isError ? '暂不可用' : isOwner ? (overview.data?.preclose?.closed ? '已关账' : '尚未关账') : '仅店主可见'} hint={overview.isError ? '请稍后重试' : isOwner ? (blockers.length ? `${blockers.length} 项阻断检查` : '当前没有阻断项') : '当前账号没有关账权限'} tone={blockers.length ? 'warning' : 'neutral'} />
    </div>
    <div className="overview-panels">
      <section className="overview-panel" aria-labelledby="today-lessons-heading"><div className="overview-panel-heading"><div><span className="eyebrow">TODAY</span><h4 id="today-lessons-heading">今日排课</h4><p>{lessons.length ? `共 ${lessons.length} 节，状态来自实时排课` : '今天暂无排课记录'}</p></div><button onClick={() => navigate('/schedule')} type="button">进入排课 →</button></div>
        {overview.isError ? <Alert message="暂时无法读取经营概览" type="warning" showIcon /> : lessons.length ? <div className="overview-list">{lessons.slice(0, 4).map((lesson) => <div className="overview-list-row" key={lesson.id}><strong>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(lesson.startsAt))}</strong><span>{lesson.student.name} · {lesson.course.name}</span><Tag>{lesson.status === 'COMPLETED' ? '已完成' : lesson.status === 'CANCELLED' ? '已取消' : '待处理'}</Tag></div>)}</div> : <div className="overview-empty">创建排课后，今日课程会显示在这里。</div>}
      </section>
      <section className="overview-panel" aria-labelledby="overview-actions-heading"><div className="overview-panel-heading"><div><span className="eyebrow">QUICK ENTRY</span><h4 id="overview-actions-heading">常用入口</h4><p>直接查看和办理日常业务。</p></div></div><div className="overview-actions">{isOwner && <><button onClick={() => navigate('/students')} type="button"><strong>学生与账户</strong><span>查找学生、课程账户和余额 →</span></button><button onClick={() => navigate('/finance')} type="button"><strong>收支与报表</strong><span>月度结果、工资和关账 →</span></button></>}</div><div className="recent-tasks"><span className="eyebrow">RECENT TASKS</span>{tasks.data?.slice(0, 3).map((task) => <button key={task.threadId} onClick={() => navigate(`/tasks/${task.threadId}`)} type="button"><span>{task.title}</span><em>{task.latestStatus === 'completed' ? '已回复' : task.latestStatus === 'failed' ? '需重试' : '进行中'}</em></button>)}{tasks.isError ? <small>任务列表暂不可用</small> : !tasks.isLoading && !tasks.data?.length && <small>暂无已保存任务</small>}</div>{blockers.length > 0 && <Alert className="overview-alert" message="本月关账存在阻断项" description={blockers.slice(0, 2).map((item) => item.message).join('；')} showIcon type="warning" />}</section>
    </div>
    {isOwner && overview.data && <div className="overview-panels"><section className="overview-panel"><div className="overview-panel-heading"><div><span className="eyebrow">ATTENTION</span><h4>待处理事项</h4><p>截至 {formatDateTime(overview.data.asOf)}</p></div></div><div className="overview-actions"><button onClick={() => navigate('/students')} type="button"><strong>欠费学生</strong><span>{overview.data.students?.arrearsCount ?? '—'} 人 →</span></button><button onClick={() => navigate('/finance?tab=payroll')} type="button"><strong>待支付工资</strong><span>{overview.data.preclose?.unpaidPayrollCount ?? '—'} 笔 →</span></button></div></section><section className="overview-panel"><div className="overview-panel-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h4>最近账户流水</h4><p>按业务发生时间倒序</p></div><button onClick={() => navigate('/students')} type="button">查看账户 →</button></div>{overview.data.recentRecords?.length ? <div className="overview-list">{overview.data.recentRecords.map((record) => <div className="overview-list-row" key={record.id}><strong>{formatDateTime(record.occurredAt)}</strong><span>{record.studentName} · {record.courseName}</span><span>{overviewRecordKind(record.kind)} · 实付 {record.paidDelta} / 赠送 {record.giftDelta}</span></div>)}</div> : <div className="overview-empty">暂无账户流水</div>}</section></div>}
  </section>;
}

function OverviewMetric({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: 'neutral' | 'positive' | 'warning' }) {
  return <div className={`overview-metric tone-${tone}`}><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

function WorkflowStep({ detail, number, title }: { detail: string; number: string; title: string }) {
  return <div className="workflow-step"><span className="step-number">{number}</span><div><strong>{title}</strong><span>{detail}</span></div></div>;
}

function ContextPanel({ activeThreadId, interactionDisabled, onCandidateSelect, onClear, onPreviewConfirmed, onRecoveryAction, previewRecheckVersion, user, workspace }: {
  activeThreadId: string | null;
  interactionDisabled: boolean;
  onCandidateSelect: CandidateSelectionHandler;
  onClear: () => void;
  onPreviewConfirmed: PreviewConfirmationHandler;
  onRecoveryAction: RecoveryActionHandler;
  previewRecheckVersion: number;
  user: AuthUser | null;
  workspace: WorkspaceState | null;
}) {
  const overview = useHomeOverview(user);
  const isCurrentWorkspace = workspace !== null && workspace.threadId === activeThreadId;
  return <div className="context-inner"><div className="context-heading"><div><span className="eyebrow">OPERATING WORKSPACE</span><Title level={3}>经营工作区</Title></div><button aria-label="清空上下文" className="clear-button" onClick={onClear} type="button">清空</button></div>
    {workspace ? <WorkspaceContent
      document={workspace.document}
      interactionDisabled={interactionDisabled}
      isCurrentWorkspace={isCurrentWorkspace}
      onCandidateSelect={onCandidateSelect}
      onPreviewConfirmed={onPreviewConfirmed}
      onRecoveryAction={onRecoveryAction}
      previewRecheckVersion={previewRecheckVersion}
      requireCoreDisplay={workspace.requireCoreDisplay ?? false}
    /> : <HomeOverview user={user} overview={overview} />}
  </div>;
}

function WorkspaceContent({ document, interactionDisabled, isCurrentWorkspace, onCandidateSelect, onPreviewConfirmed, onRecoveryAction, previewRecheckVersion, requireCoreDisplay = false }: {
  document: WorkspaceDocument;
  interactionDisabled: boolean;
  isCurrentWorkspace: boolean;
  onCandidateSelect: CandidateSelectionHandler;
  onPreviewConfirmed: PreviewConfirmationHandler;
  onRecoveryAction: RecoveryActionHandler;
  previewRecheckVersion: number;
  requireCoreDisplay?: boolean;
}) {
  const navigate = useNavigate();
  const taskVersion = typeof (document as WorkspaceWithTaskVersion).taskVersion === 'number' && Number.isInteger((document as WorkspaceWithTaskVersion).taskVersion)
    ? (document as WorkspaceWithTaskVersion).taskVersion
    : undefined;
  return <div aria-label="工作区内容" className="live-workspace">
      <Title className="live-workspace-title" level={5}>{document.title}</Title>
      {document.blocks.map((block, index) => {
        if (block.type === 'summary') return <section className="workspace-summary" key={`summary-${index}`}><strong>{block.title}</strong><p>{block.text}</p></section>;
        if (block.type === 'entity-picker') return <section aria-label="候选实体" className="workspace-summary entity-picker" key={`entity-picker-${index}`}><strong>{block.title}</strong><div className="entity-candidates">{block.candidates.map((candidate) => <button aria-label={`选择候选：${candidate.label}`} className="entity-candidate" disabled={!isCurrentWorkspace || interactionDisabled} key={candidate.id} onClick={() => { if (!interactionDisabled) onCandidateSelect(candidate.id, taskVersion); }} type="button"><span>{candidate.label}</span>{candidate.description && <small>{candidate.description}</small>}</button>)}</div></section>;
        if (block.type === 'data-table') return <div className="workspace-table-wrap" key={`table-${index}`}><table aria-label="查询结果" className="workspace-table"><thead><tr>{block.columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.columns.map((column) => <td key={column.key}>{String(row[column.key] ?? '—')}</td>)}</tr>)}</tbody></table></div>;
        if (block.type === 'calendar') return <section aria-label="排课日历" className="workspace-summary workspace-calendar" key={`calendar-${index}`}><strong>排课日历</strong><p>{formatDateTime(block.rangeStart)} 至 {formatDateTime(block.rangeEnd)}</p><div className="calendar-events">{block.events.map((event) => <div className="calendar-event" key={event.id}><strong>{event.title}</strong><span>{formatDateTime(event.start)} — {formatDateTime(event.end)}</span></div>)}</div></section>;
        if (block.type === 'alert-list') return <div aria-label="经营提醒" className="workspace-alerts" key={`alerts-${index}`}>
          {block.alerts.map((alert, alertIndex) => <Alert key={`${alert.title}-${alertIndex}`} message={alert.title} description={alert.detail} showIcon type={alert.severity} />)}
        </div>;
        if (block.type === 'metric-grid') return <div aria-label="经营指标" className="workspace-metrics" key={`metrics-${index}`}>
          {block.metrics.map((metric, metricIndex) => <div className={`workspace-metric tone-${metric.tone}`} key={`${metric.label}-${metricIndex}`}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
        </div>;
        if (block.type === 'ledger-detail') return <section aria-label="流水明细" className="workspace-summary ledger-detail" key={`ledger-${index}`}><strong>流水明细</strong><p>账户：{block.accountId}</p>{block.entries.map((entry) => <div className="ledger-entry" key={entry.id}><div><strong>{entry.description}</strong><span>{formatDateTime(entry.occurredAt)}</span></div><span>实收 {entry.paidDelta} · 赠送 {entry.giftDelta}</span></div>)}</section>;
        if (block.type === 'calculation-breakdown') return <section aria-label="金额计算" className="workspace-summary" key={`calculation-${index}`}><strong>{block.title}</strong>{block.lines.map((line) => <p key={line.label}>{line.label}：¥{line.amount}</p>)}<p><strong>合计：¥{block.total}</strong></p></section>;
        if (block.type === 'receipt') return <ReceiptBlockView block={block} key={`receipt-${index}`} />;
        if (block.type === 'action-preview') return <PreviewConfirmationCard interactionDisabled={interactionDisabled} key={block.previewId} onConfirmed={onPreviewConfirmed} preview={block} previewRecheckVersion={previewRecheckVersion} requireCoreDisplay={requireCoreDisplay} />;
        if (block.type === 'error-recovery') return <section aria-label="错误恢复" className="workspace-summary error-recovery" key={`error-${index}`}><Alert message={block.message} showIcon type="error" /><div className="recovery-actions">{block.actions.map((action) => <button className="recovery-action" disabled={interactionDisabled} key={action} onClick={() => { if (action === 'open-structured-page') navigate('/finance'); else onRecoveryAction(action); }} type="button">{action === 'refresh' ? '刷新结果' : action === 'repreview' ? '重新生成预览' : '打开结构化页面'}</button>)}</div></section>;
        return null;
      })}
      {document.sources.length > 0 && <section aria-label="数据来源" className="workspace-summary workspace-sources"><strong>数据来源</strong>{document.sources.map((source) => <div className="source-row" key={`${source.type}-${source.id}`}><span>{source.label}</span><small>{source.type} · {source.id}</small></div>)}</section>}
      {document.blocks.length === 0 && <p className="workspace-empty">当前结果没有可展示的工作区内容。</p>}
    </div>;
}

type PreviewCardData = Pick<Extract<WorkspaceBlock, { type: 'action-preview' }>, 'type' | 'previewId' | 'actionType' | 'schemaVersion' | 'riskLevel' | 'title'> & { expiresAt?: string };

function PreviewConfirmationCard({ confirmAllowed = true, interactionDisabled, onConfirmed, preview, previewRecheckVersion, requireCoreDisplay }: { confirmAllowed?: boolean; interactionDisabled: boolean; onConfirmed: PreviewConfirmationHandler; preview: PreviewCardData; previewRecheckVersion: number; requireCoreDisplay: boolean }) {
  const [status, setStatus] = useState<'unknown' | 'loading' | 'pending' | 'confirming' | 'executed' | 'cancelled' | 'stale' | 'expired' | 'failed' | 'mismatch'>('unknown');
  const [message, setMessage] = useState('');
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);
  const [coreDisplay, setCoreDisplay] = useState<Record<string, unknown> | null>(null);
  const [coreActionType, setCoreActionType] = useState<string | null>(null);
  const [coreExpiresAt, setCoreExpiresAt] = useState<string | null>(null);
  const [corePreviewRead, setCorePreviewRead] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const confirmingRef = useRef(false);
  const onConfirmedRef = useRef(onConfirmed);
  onConfirmedRef.current = onConfirmed;

  const applyCurrentPreview = (current: Awaited<ReturnType<typeof getAssistantPreview>>) => {
    setCorePreviewRead(true);
    setReceipt(current.receipt);
    setCoreDisplay(current.display ?? null);
    setCoreActionType(current.actionType);
    setCoreExpiresAt(current.expiresAt);
    if (current.status === 'EXECUTED') {
      setStatus('executed');
      setMessage('已确认并执行。');
      onConfirmedRef.current(current.previewId);
      return;
    }
    const metadataMismatch = current.actionType !== preview.actionType || current.schemaVersion !== preview.schemaVersion || current.riskLevel !== preview.riskLevel;
    if (current.status === 'PENDING' && metadataMismatch) {
      setStatus('mismatch');
      setMessage('历史确认单与当前预览不一致，已禁止确认。请重新生成确认单。');
      return;
    }
    if (requireCoreDisplay && current.status === 'PENDING' && !current.display) {
      setStatus('mismatch');
      setMessage('系统未提供当前确认内容，已禁止确认。请重新生成确认单。');
      return;
    }
    const locallyExpired = current.status === 'PENDING' && Date.parse(current.expiresAt) <= Date.now();
    setStatus(locallyExpired ? 'expired' : current.status.toLowerCase() as 'pending' | 'cancelled' | 'expired' | 'stale');
    setMessage(current.status === 'PENDING' && !confirmAllowed ? '历史待确认步骤仅供查看，不能直接执行。' : '');
  };

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setMessage('');
    setReceipt(null);
    setCoreDisplay(null);
    setCoreActionType(null);
    setCoreExpiresAt(null);
    setCorePreviewRead(false);
    void getAssistantPreview({ token: getToken(), previewId: preview.previewId }).then((current) => {
      if (!active) return;
      applyCurrentPreview(current);
    }).catch((cause) => {
      if (!active) return;
      setReceipt(null);
      setStatus('unknown');
      setMessage(cause instanceof Error ? cause.message : '无法读取预览当前状态，请稍后重查。');
    });
    return () => { active = false; };
  }, [confirmAllowed, preview.actionType, preview.previewId, preview.riskLevel, preview.schemaVersion, previewRecheckVersion]);

  useEffect(() => {
    const expiresAt = coreExpiresAt ?? (!requireCoreDisplay ? preview.expiresAt ?? null : null);
    if (!expiresAt) return undefined;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setStatus((current) => current === 'pending' ? 'expired' : current);
      return undefined;
    }
    const timer = window.setTimeout(() => setStatus((current) => current === 'pending' ? 'expired' : current), Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [coreExpiresAt, preview.expiresAt, requireCoreDisplay]);

  const confirm = async () => {
    if (!confirmAllowed || interactionDisabled || confirmingRef.current || (status !== 'pending' && status !== 'failed')) return;
    const idempotencyKey = getStablePreviewIdempotencyKey(preview.previewId, idempotencyKeyRef);
    if (!idempotencyKey) {
      setStatus('failed');
      setMessage('当前浏览器无法安全生成确认标识，请稍后重试。');
      return;
    }
    confirmingRef.current = true;
    setStatus('confirming');
    setMessage('');
    try {
      const result = await confirmAssistantPreview({ token: getToken(), previewId: preview.previewId, idempotencyKey });
      setReceipt(result.receipt);
      setStatus('executed');
      setMessage('已确认并执行。');
      onConfirmed(result.previewId);
    } catch (cause) {
      if (cause instanceof UnknownConfirmationError) {
        setStatus('unknown');
        setMessage(cause.message);
        return;
      }
      setStatus('failed');
      setMessage(cause instanceof Error ? cause.message : '确认失败，请稍后重试。');
    } finally {
      confirmingRef.current = false;
    }
  };
  const statusMessage = status === 'mismatch' ? message : status === 'pending' && !confirmAllowed ? message : status === 'cancelled' ? '预览已取消，未执行任何操作。' : status === 'stale' ? '预览已失效，未执行任何操作。请重新生成预览。' : status === 'expired' ? '预览已过期，未执行任何操作。请重新生成预览。' : undefined;
  const canShowDetails = !requireCoreDisplay || corePreviewRead;
  const currentExpiresAt = coreExpiresAt ?? (!requireCoreDisplay ? preview.expiresAt ?? null : null);
  return <section aria-label="操作预览" className="workspace-summary preview-card">
    {canShowDetails ? <>
      <strong>{typeof coreDisplay?.title === 'string' ? coreDisplay.title : preview.title}</strong>
      <p className="preview-guidance">确认前请核对预览内容；确认后才会写入真实业务数据。</p>
      {coreDisplay && <section aria-label="当前确认单内容" className="preview-core-display">
        {typeof coreDisplay.summary === 'string' && <p>{coreDisplay.summary}</p>}
        <PreviewFacts value={coreDisplay} actionType={coreActionType ?? preview.actionType} />
      </section>}
      {currentExpiresAt && <p className="preview-expiry">有效期至 {formatDateTime(currentExpiresAt)}</p>}
      <details className="preview-technical-details">
        <summary>查看技术详情</summary>
        <dl>
          <div className="receipt-row"><dt>动作类型</dt><dd>{preview.actionType}</dd></div>
          <div className="receipt-row"><dt>数据版本</dt><dd>{preview.schemaVersion}</dd></div>
          <div className="receipt-row"><dt>风险代码</dt><dd>{preview.riskLevel}</dd></div>
          <div className="receipt-row"><dt>预览编号</dt><dd>{preview.previewId}</dd></div>
        </dl>
      </details>
      {status === 'loading' && <Alert className="preview-alert" message="正在核对系统当前确认单…" showIcon type="info" />}
      {status === 'unknown' && <Alert className="preview-alert" message={message || '无法读取预览当前状态，尚未确认。'} showIcon type="warning" />}
    </> : <Alert className="preview-alert" message={status === 'loading' ? '正在核对系统当前确认单…' : message || '暂时无法读取当前确认单，请稍后重查。'} showIcon type={status === 'loading' ? 'info' : 'warning'} />}
    {statusMessage && <Alert className="preview-alert" message={statusMessage} showIcon type="warning" />}
    {status === 'executed' ? <>
      <Alert message={message} showIcon type="success" />
      <ReceiptResult receipt={receipt} />
    </> : <>
      {message && status !== 'unknown' && status !== 'mismatch' && !(status === 'pending' && !confirmAllowed) && <Alert className="preview-alert" message={message} showIcon type="error" />}
      {status === 'unknown' ? <Button disabled={interactionDisabled} onClick={() => {
        setStatus('loading');
        setMessage('');
        setReceipt(null);
        setCoreDisplay(null);
        setCoreActionType(null);
        setCoreExpiresAt(null);
        setCorePreviewRead(false);
        void getAssistantPreview({ token: getToken(), previewId: preview.previewId }).then(applyCurrentPreview).catch((cause) => {
          setStatus('unknown');
          setMessage(cause instanceof Error ? cause.message : '无法读取预览当前状态，请稍后重查。');
        });
      }} type="default">重查预览状态</Button> : (status === 'pending' || status === 'failed' || status === 'confirming') && confirmAllowed && <Button danger={preview.riskLevel === 'L2'} disabled={interactionDisabled || status === 'confirming'} loading={status === 'confirming'} onClick={confirm} type="primary">
        {status === 'failed' ? '重试确认' : preview.riskLevel === 'L2' ? '确认并登记' : '确认执行'}
      </Button>}
      {status === 'mismatch' && <Button disabled type="default">确认单信息不一致</Button>}
      {status === 'expired' && <Button disabled type="default">预览已过期</Button>}
      {status === 'stale' && <Button disabled type="default">预览已失效</Button>}
      {status === 'cancelled' && <Button disabled type="default">预览已取消</Button>}
    </>}
  </section>;
}

function ReceiptBlockView({ block }: { block: Extract<WorkspaceBlock, { type: 'receipt' }> }) {
  return <section aria-label="业务回执" className="workspace-summary receipt-block">
    <strong>{block.title}</strong>
    <p>回执编号：{block.receiptId}</p>
    <p>状态：{block.status === 'succeeded' ? '成功' : '失败'} · 时间：{formatDateTime(block.occurredAt)}</p>
  </section>;
}

function receiptValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[无法展示]';
  }
}

function ReceiptResult({ receipt }: { receipt: Record<string, unknown> | null }) {
  if (!receipt) return <Alert className="preview-alert" message="操作已确认，但未返回执行回执。" showIcon type="info" />;
  const entries = Object.entries(receipt);
  const labels: Record<string,string> = { amount:'登记金额', actualRefundAmount:'实际退款', feeAmount:'手续费', period:'业务月份', count:'记录数量', executedAt:'登记时间', occurredAt:'业务时间' };
  const visible = entries.flatMap(([key,value]) => labels[key] && (typeof value === 'string' || typeof value === 'number')
    ? [{ label:labels[key], value:key.endsWith('At') && typeof value === 'string' ? formatDateTime(value) : String(value) }] : []);
  const balance = receipt.balanceAfter;
  if (balance && typeof balance === 'object' && !Array.isArray(balance)) {
    const values = balance as Record<string,unknown>;
    for (const [key,label] of [['paidBalance','登记后实收余额'],['giftBalance','登记后赠送余额'],['totalBalance','登记后总余额']]) {
      if (typeof values[key!] === 'string') visible.push({label:label!,value:values[key!] as string});
    }
  }
  return <section aria-label="执行回执" className="receipt-result">
    <strong>执行回执</strong>
    {entries.length === 0 ? <p>操作返回了空执行回执。</p> : <>
      {visible.length ? <dl>{visible.map(({label,value}) => <div className="receipt-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p>登记已完成，可到对应业务页面查看记录。</p>}
      <details className="preview-technical-details"><summary>查看回执技术详情</summary><dl>{entries.filter(([key]) => !labels[key] && key !== 'balanceAfter').map(([key,value]) => <div className="receipt-row" key={key}><dt>{key}</dt><dd>{receiptValue(value)}</dd></div>)}</dl></details>
    </>}
  </section>;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间无效';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export type { NavItem, AssistantState };
