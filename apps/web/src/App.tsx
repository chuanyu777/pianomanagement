import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Input, Tag, Typography } from 'antd';
import { Link, Outlet, Route, Routes, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { confirmAssistantPreview, createAssistantIds, isTerminalAssistantEvent, startAssistantRun, streamAssistantEvents, type AssistantRunStatus, type AssistantUiEvent, type WorkspaceBlock, type WorkspaceDocument } from './assistant-client.js';
import { StructuredWorkbench } from './structured-workbench.js';

const { Text, Title } = Typography;
const { TextArea } = Input;
const TOKEN_KEY = 'pianomanager.accessToken';

type NavItem = { label: string; description: string; path: string; icon: string };
const navItems: NavItem[] = [
  { label: '工作台', description: 'AI 协作入口', path: '/', icon: '⌂' },
  { label: '学生与账户', description: '学生真实数据', path: '/structured/students', icon: '◉' },
  { label: '排课与课消', description: '课程真实数据', path: '/structured/schedule', icon: '▦' },
  { label: '收支与报表', description: '月度经营数据', path: '/structured/finance', icon: '◫' },
];
const suggestions = ['查找学生账户', '预览一次收款', '查看今日排课'];

type AssistantState = {
  available: boolean;
  core: { available: boolean };
  agentRuntime: { available: boolean };
  checkedAt: string;
  message: 'AI 助手已连接' | 'AI 助手暂不可用';
};
type AuthUser = { id: string; username: string; role: string; teacherId?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

function isAssistantState(value: unknown): value is AssistantState {
  if (!isRecord(value) || !isRecord(value.core) || !isRecord(value.agentRuntime)) return false;
  return typeof value.available === 'boolean' && typeof value.core.available === 'boolean' &&
    typeof value.agentRuntime.available === 'boolean' && hasString(value, 'checkedAt') &&
    (value.message === 'AI 助手已连接' || value.message === 'AI 助手暂不可用');
}

function getToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}

async function apiRequest<T>(path: string, validate: (value: unknown) => value is T, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) throw new Error(`请求失败 (${response.status})`);
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

export function App() {
  const [token, setToken] = useState(() => getToken());
  const [user, setUser] = useState<AuthUser | null>(null);
  const onLogin = (accessToken: string, loggedInUser: AuthUser) => {
    window.localStorage.setItem(TOKEN_KEY, accessToken);
    setToken(accessToken);
    setUser(loggedInUser);
  };
  const onLogout = () => {
    window.localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  if (!token) return <LoginPage onLogin={onLogin} />;
  return (
    <Routes>
      <Route element={<WorkspaceLayout onLogout={onLogout} user={user} />} path="/">
        <Route element={<WorkspaceHome />} index />
        <Route element={<StructuredWorkbench section="students" />} path="structured/students" />
        <Route element={<StructuredWorkbench section="schedule" />} path="structured/schedule" />
        <Route element={<StructuredWorkbench section="finance" />} path="structured/finance" />
      </Route>
      <Route element={<WorkspaceLayout onLogout={onLogout} user={user} />} path="*">
        <Route element={<WorkspaceHome />} index />
      </Route>
    </Routes>
  );
}

function LoginPage({ onLogin }: { onLogin: (token: string, user: AuthUser) => void }) {
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
      const loginPayload = payload as { accessToken: string; user: Record<string, unknown> };
      onLogin(loginPayload.accessToken, {
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
  const [workspace, setWorkspace] = useState<WorkspaceDocument | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const assistantState = useAssistantState();
  const isAssistantAvailable = assistantState.data?.available === true;
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link aria-label="返回 AI 工作台" className="brand" to="/">
          <span className="brand-mark">P</span><span><strong>琴行经营</strong><small>AI 工作台</small></span>
        </Link>
        <div className="topbar-actions">
          <Tag className="security-tag">安全预览模式</Tag>
          <span aria-label={isAssistantAvailable ? 'AI 已连接' : 'AI 尚未接通'} className="connection-status">
            <span className="status-dot" /> {isAssistantAvailable ? 'AI 已连接' : 'AI 尚未接通'}
          </span>
          {user && <span className="signed-in-user">{user.username}</span>}
          <Button aria-label="退出登录" onClick={onLogout} size="small">退出</Button>
        </div>
      </header>
      <div className="workspace-grid">
        <aside aria-label="主导航" className="sidebar panel-surface">
          <div className="sidebar-heading"><span className="eyebrow">NAVIGATION</span><span className="sidebar-caption">经营入口</span></div>
          <nav className="nav-list">
            {navItems.map((item) => {
              const active = location.pathname === item.path;
              return <button className={`nav-item ${active ? 'is-active' : ''}`} key={item.path} onClick={() => navigate(item.path)} type="button">
                <span className="nav-icon" aria-hidden="true">{item.icon}</span><span className="nav-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
                {active && <span className="nav-active-mark" />}
              </button>;
            })}
          </nav>
          <div className="sidebar-footer"><span className="eyebrow">SYSTEM</span><span>Core API {assistantState.data?.core.available ? '已连接' : '未连接'}</span><span className="muted">已登录 · 真实业务数据</span></div>
        </aside>
        <main className="main-column"><Outlet context={{ assistantState, onLogout, setWorkspace }} /></main>
        <aside aria-label="经营工作区" className="context-panel panel-surface"><ContextPanel onClear={() => setWorkspace(null)} workspace={workspace} /></aside>
      </div>
    </div>
  );
}

function WorkspaceHome() {
  const [prompt, setPrompt] = useState('');
  const [runStatus, setRunStatus] = useState<AssistantRunStatus | 'idle' | 'connecting' | 'connection_failed'>('idle');
  const [runId, setRunId] = useState('');
  const [reply, setReply] = useState('');
  const [clarification, setClarification] = useState('');
  const [runError, setRunError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const { assistantState, onLogout, setWorkspace } = useOutletContext<{
    assistantState: ReturnType<typeof useAssistantState>;
    onLogout: () => void;
    setWorkspace: (workspace: WorkspaceDocument | null) => void;
  }>();
  const isUnavailable = assistantState.isError || !assistantState.data?.available;
  const isBusy = runStatus === 'connecting' || runStatus === 'queued' || runStatus === 'running';
  useEffect(() => () => controllerRef.current?.abort(), []);

  const handleEvent = (event: AssistantUiEvent): boolean => {
    switch (event.type) {
      case 'assistant.delta':
        setReply((current) => current + event.text);
        break;
      case 'assistant.message':
        setReply(event.markdown);
        break;
      case 'workspace.replace':
        setWorkspace(event.document);
        break;
      case 'clarification.requested':
        setClarification(event.question);
        setRunStatus('waiting_for_input');
        return true;
      case 'run.completed':
        setRunStatus('completed');
        return true;
      case 'run.failed':
        setRunStatus('failed');
        setRunError(event.message);
        return true;
    }
    return false;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || isBusy) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunStatus('connecting');
    setRunId('');
    setReply('');
    setWorkspace(null);
    setClarification('');
    setRunError('');
    try {
      const ids = createAssistantIds();
      const run = await startAssistantRun({ token: getToken(), message, ...ids });
      setRunId(run.runId);
      setRunStatus(run.status);
      if (run.status === 'completed' || run.status === 'failed') setRunStatus('running');
      let receivedFinalEvent = false;
      await streamAssistantEvents({
        token: getToken(),
        run,
        signal: controller.signal,
        onEvent: (assistantEvent) => {
          if (isTerminalAssistantEvent(assistantEvent) || assistantEvent.type === 'clarification.requested') receivedFinalEvent = true;
          return handleEvent(assistantEvent);
        },
      });
      if (!receivedFinalEvent && !controller.signal.aborted) {
        setRunStatus('connection_failed');
        setRunError('事件连接已结束，但运行没有返回完成状态。可以稍后重试。');
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setRunStatus('connection_failed');
      setRunError(cause instanceof Error ? cause.message : '无法连接 AI 助手，请检查网络后重试。');
    }
  };

  const statusLabel: Record<typeof runStatus, string> = {
    idle: '尚未开始', connecting: '正在连接', queued: '排队中', running: '运行中',
    waiting_for_input: '等待补充信息', completed: '已完成', failed: '运行失败', connection_failed: '连接失败',
  };
  return (
    <section aria-labelledby="welcome-heading" className="home-view">
      <div className="home-intro"><div><span className="eyebrow accent-eyebrow">AI-FIRST OPERATING DESK</span><Title id="welcome-heading" level={1}>把经营问题交给工作台。</Title>
        <p className="intro-copy">用自然语言描述目标，AI 会先读取必要信息、解释判断依据，再生成一份可确认的操作预览。</p></div>
        <div className="date-chip"><span className="date-label">业务日</span><strong>尚未设置</strong></div></div>
      <Alert className="availability-alert" description={isUnavailable
        ? '状态检查显示 AI 服务暂不可用。你仍可以提交问题，工作台会报告实际连接结果；结构化入口可继续查看真实业务数据。'
        : assistantState.data?.message ?? 'AI 已准备好接收任务。'}
        title={isUnavailable ? 'AI 助手暂不可用' : 'AI 助手已连接'} showIcon type={isUnavailable ? 'warning' : 'success'} />
      <Card className="prompt-card" variant="borderless">
        <div className="card-heading"><div><span className="eyebrow">START WITH A QUESTION</span><Title level={3}>你想先处理什么？</Title></div><Tag className="preview-tag">所有动作先预览</Tag></div>
        <form onSubmit={submit}>
          <TextArea aria-label="经营问题" autoSize={{ minRows: 5, maxRows: 8 }} disabled={isBusy} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：帮我看看本周有哪些待确认的课消……" value={prompt} />
          <div className="prompt-footer"><Text className="prompt-hint">{isUnavailable ? 'AI 服务当前不可用，提交后会显示连接结果。' : '消息将发送给 AI 助手；写入操作仍须由你确认。'}</Text><Button disabled={prompt.trim().length === 0 || isBusy} loading={runStatus === 'connecting'} htmlType="submit" type="primary">{isBusy ? '处理中…' : '发送消息'} <span aria-hidden="true">↗</span></Button></div>
        </form>
        <div className="suggestion-row" aria-label="示例入口"><span className="suggestion-label">可以从这里开始</span>{suggestions.map((suggestion) => <button className="suggestion-button" disabled={isBusy} key={suggestion} onClick={() => setPrompt(suggestion)} type="button">{suggestion}</button>)}</div>
        {runStatus !== 'idle' && <section aria-label="AI 运行结果" className={`assistant-run assistant-run-${runStatus}`}>
          <div className="assistant-run-heading"><strong>运行状态</strong><Tag>{statusLabel[runStatus]}</Tag>{runId && <Text className="run-id">Run {runId}</Text>}</div>
          {reply && <div aria-live="polite" className="assistant-reply"><strong>AI 助手</strong><p>{reply}</p></div>}
          {clarification && <Alert className="run-alert" message="需要补充信息" description={clarification} showIcon type="info" />}
          {runError && <Alert className="run-alert" message={runError} showIcon type="error" action={runError.includes('登录状态已失效') ? <Button onClick={onLogout} size="small">返回登录</Button> : undefined} />}
        </section>}
      </Card>
      <section aria-labelledby="workflow-heading" className="workflow-section"><div className="section-heading"><div><span className="eyebrow">SAFE WORKFLOW</span><Title id="workflow-heading" level={3}>每一次操作都经过确认</Title></div><Text className="section-note">当前为产品骨架</Text></div>
        <div className="workflow-steps"><WorkflowStep number="01" title="描述" detail="用自然语言说明目标" /><span className="step-arrow" aria-hidden="true">→</span><WorkflowStep number="02" title="预览" detail="查看数据与计算依据" /><span className="step-arrow" aria-hidden="true">→</span><WorkflowStep number="03" title="确认" detail="由 Core API 执行写入" /></div>
      </section>
    </section>
  );
}

function WorkflowStep({ detail, number, title }: { detail: string; number: string; title: string }) {
  return <div className="workflow-step"><span className="step-number">{number}</span><div><strong>{title}</strong><span>{detail}</span></div></div>;
}

function ContextPanel({ onClear, workspace }: { onClear: () => void; workspace: WorkspaceDocument | null }) {
  const hasContent = workspace !== null;
  return <div className="context-inner"><div className="context-heading"><div><span className="eyebrow">OPERATING WORKSPACE</span><Title level={3}>经营工作区</Title></div><button aria-label="清空上下文" className="clear-button" disabled={!hasContent} onClick={onClear} type="button">清空</button></div>
    {workspace ? <div aria-label="工作区内容" className="live-workspace">
      <Title className="live-workspace-title" level={5}>{workspace.title}</Title>
      {workspace.blocks.map((block, index) => {
        if (block.type === 'summary') return <section className="workspace-summary" key={`summary-${index}`}><strong>{block.title}</strong><p>{block.text}</p></section>;
        if (block.type === 'alert-list') return <div aria-label="经营提醒" className="workspace-alerts" key={`alerts-${index}`}>
          {block.alerts.map((alert, alertIndex) => <Alert key={`${alert.title}-${alertIndex}`} message={alert.title} description={alert.detail} showIcon type={alert.severity} />)}
        </div>;
        if (block.type === 'metric-grid') return <div aria-label="经营指标" className="workspace-metrics" key={`metrics-${index}`}>
          {block.metrics.map((metric, metricIndex) => <div className={`workspace-metric tone-${metric.tone}`} key={`${metric.label}-${metricIndex}`}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
        </div>;
        if (block.type === 'calculation-breakdown') return <section aria-label="金额计算" className="workspace-summary" key={`calculation-${index}`}><strong>{block.title}</strong>{block.lines.map((line) => <p key={line.label}>{line.label}：¥{line.amount}</p>)}<p><strong>合计：¥{block.total}</strong></p></section>;
        if (block.type === 'receipt') return <ReceiptBlockView block={block} key={`receipt-${index}`} />;
        if (block.type === 'action-preview') return <PreviewConfirmationCard key={`preview-${index}`} preview={block} />;
        return null;
      })}
      {workspace.blocks.length === 0 && <p className="workspace-empty">当前结果没有可展示的工作区内容。</p>}
    </div> : <div className="empty-context"><span className="empty-orbit" aria-hidden="true">＋</span><strong>还没有工作区内容</strong><span>向助手提问后，真实返回的摘要、提醒和指标会显示在这里。</span></div>}
    <div className="boundary-card"><div className="boundary-title"><span className="boundary-icon">◌</span> AI 的安全边界</div><ul><li>只能查询和申请 Preview</li><li>不能直接确认资金或课消</li><li>写入由浏览器直接调用 Core</li></ul></div>
    <div className="context-meta"><span>数据连接</span><strong>Core API</strong></div><div className="context-meta"><span>会话状态</span><strong>尚未开始</strong></div>
  </div>;
}

function PreviewConfirmationCard({ preview }: { preview: Extract<WorkspaceBlock, { type: 'action-preview' }> }) {
  const [status, setStatus] = useState<'idle' | 'confirming' | 'confirmed' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);
  const [expired, setExpired] = useState(() => Date.parse(preview.expiresAt) <= Date.now());
  useEffect(() => {
    const expiresAt = Date.parse(preview.expiresAt);
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setExpired(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [preview.expiresAt]);

  const confirm = async () => {
    if (expired || status === 'confirming' || status === 'confirmed' || typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') return;
    setStatus('confirming');
    setMessage('');
    try {
      const result = await confirmAssistantPreview({ token: getToken(), previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
      setReceipt(result.receipt);
      setStatus('confirmed');
      setMessage('已确认并执行。');
    } catch (cause) {
      setStatus('failed');
      setMessage(cause instanceof Error ? cause.message : '确认失败，请稍后重试。');
    }
  };
  return <section aria-label="操作预览" className="workspace-summary">
    <strong>{preview.title}</strong>
    <p>动作类型：{preview.actionType} · 版本：{preview.schemaVersion}</p>
    <p>风险等级：{preview.riskLevel} · 有效至 {formatDateTime(preview.expiresAt)}</p>
    <p>预览编号：{preview.previewId}</p>
    {expired && status !== 'confirmed' && <Alert className="preview-alert" message="预览已过期，未执行任何操作。请重新生成预览。" showIcon type="warning" />}
    {status === 'confirmed' ? <>
      <Alert message={message} showIcon type="success" />
      <ReceiptResult receipt={receipt} />
    </> : <>
      {message && <Alert className="preview-alert" message={message} showIcon type="error" />}
      <Button danger={preview.riskLevel === 'L2'} disabled={expired || status === 'confirming'} loading={status === 'confirming'} onClick={confirm} type="primary">
        {expired ? '预览已过期' : status === 'failed' ? '重试确认' : preview.riskLevel === 'L2' ? '确认并登记' : '确认执行'}
      </Button>
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
  if (!receipt) return <Alert className="preview-alert" message="Core 已确认，但未返回回执明细。" showIcon type="info" />;
  const entries = Object.entries(receipt);
  return <section aria-label="Core 回执明细" className="receipt-result">
    <strong>Core 回执明细</strong>
    {entries.length === 0 ? <p>Core 返回了空回执。</p> : <dl>{entries.map(([key, value]) => <div className="receipt-row" key={key}><dt>{key}</dt><dd>{receiptValue(value)}</dd></div>)}</dl>}
  </section>;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间无效';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export type { NavItem, AssistantState };
