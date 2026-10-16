import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Input, Tag, Typography } from 'antd';
import { Link, Outlet, Route, Routes, useLocation, useNavigate, useOutletContext } from 'react-router-dom';

const { Text, Title } = Typography;
const { TextArea } = Input;

type NavItem = {
  label: string;
  description: string;
  path: string;
  icon: string;
};

const navItems: NavItem[] = [
  { label: '工作台', description: 'AI 协作入口', path: '/', icon: '⌂' },
  { label: '学生与账户', description: '结构化查询入口', path: '/structured/students', icon: '◉' },
  { label: '排课与课消', description: '结构化查询入口', path: '/structured/schedule', icon: '▦' },
  { label: '收支与报表', description: '结构化查询入口', path: '/structured/finance', icon: '◫' },
];

const suggestions = ['查找学生账户', '预览一次收款', '查看今日排课'];

type AssistantState = {
  available: boolean;
  core: { available: boolean };
  agentRuntime: { available: boolean };
  checkedAt: string;
  message: 'AI 助手已连接' | 'AI 助手暂不可用';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAssistantState(value: unknown): value is AssistantState {
  if (!isRecord(value) || !isRecord(value.core) || !isRecord(value.agentRuntime)) return false;
  return (
    typeof value.available === 'boolean' &&
    typeof value.core.available === 'boolean' &&
    typeof value.agentRuntime.available === 'boolean' &&
    typeof value.checkedAt === 'string' &&
    (value.message === 'AI 助手已连接' || value.message === 'AI 助手暂不可用')
  );
}

async function getAssistantState(): Promise<AssistantState> {
  const response = await fetch('/api/assistant/status', {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`assistant status returned ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isAssistantState(payload)) throw new Error('assistant status returned an invalid payload');
  return payload;
}

function useAssistantState() {
  return useQuery({
    queryKey: ['assistant-status'],
    queryFn: getAssistantState,
    refetchInterval: 10_000,
  });
}

export function App() {
  return (
    <Routes>
      <Route element={<WorkspaceLayout />} path="/">
        <Route element={<WorkspaceHome />} index />
        <Route element={<StructuredFallback />} path="structured/:section" />
      </Route>
    </Routes>
  );
}

function WorkspaceLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const assistantState = useAssistantState();
  const isAssistantAvailable = assistantState.data?.available === true;

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link aria-label="返回 AI 工作台" className="brand" to="/">
          <span className="brand-mark">P</span>
          <span>
            <strong>琴行经营</strong>
            <small>AI 工作台</small>
          </span>
        </Link>
        <div className="topbar-actions">
          <Tag className="security-tag">只读安全模式</Tag>
          <span aria-label={isAssistantAvailable ? 'AI 已连接' : 'AI 尚未接通'} className="connection-status">
            <span className="status-dot" /> {isAssistantAvailable ? 'AI 已连接' : 'AI 尚未接通'}
          </span>
          <button aria-label="账户菜单" className="avatar-button" type="button">
            管
          </button>
        </div>
      </header>

      <div className="workspace-grid">
        <aside aria-label="主导航" className="sidebar panel-surface">
          <div className="sidebar-heading">
            <span className="eyebrow">NAVIGATION</span>
            <span className="sidebar-caption">经营入口</span>
          </div>
          <nav className="nav-list">
            {navItems.map((item) => {
              const active = location.pathname === item.path;
              return (
                <button
                  className={`nav-item ${active ? 'is-active' : ''}`}
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  type="button"
                >
                  <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                  <span className="nav-copy">
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                  {active && <span className="nav-active-mark" />}
                </button>
              );
            })}
          </nav>
          <div className="sidebar-footer">
            <span className="eyebrow">SYSTEM</span>
            <span>Core API {assistantState.data?.core.available ? '已连接' : '未连接'}</span>
            <span className="muted">本地工作台 · 无业务数据</span>
          </div>
        </aside>

        <main className="main-column">
          <Outlet context={{ assistantState }} />
        </main>

        <aside aria-label="当前上下文" className="context-panel panel-surface">
          <ContextPanel />
        </aside>
      </div>
    </div>
  );
}

function WorkspaceHome() {
  const [prompt, setPrompt] = useState('');
  const { assistantState } = useOutletContext<{ assistantState: ReturnType<typeof useAssistantState> }>();

  const isUnavailable = assistantState.isError || !assistantState.data?.available;

  return (
    <section aria-labelledby="welcome-heading" className="home-view">
      <div className="home-intro">
        <div>
          <span className="eyebrow accent-eyebrow">AI-FIRST OPERATING DESK</span>
          <Title id="welcome-heading" level={1}>把经营问题交给工作台。</Title>
          <p className="intro-copy">
            用自然语言描述目标，AI 会先读取必要信息、解释判断依据，再生成一份可确认的操作预览。
          </p>
        </div>
        <div className="date-chip">
          <span className="date-label">业务日</span>
          <strong>尚未设置</strong>
        </div>
      </div>

      <Alert
        className="availability-alert"
        description={
          isUnavailable
            ? '当前没有接入 Agent Runtime，输入不会发送到任何模型或业务接口。你仍可以使用右侧结构化入口查看产品边界。'
            : assistantState.data?.message ?? 'AI 已准备好接收任务。'
        }
        title={isUnavailable ? 'AI 助手暂不可用' : 'AI 助手已连接'}
        showIcon
        type={isUnavailable ? 'warning' : 'success'}
      />

      <Card className="prompt-card" variant="borderless">
        <div className="card-heading">
          <div>
            <span className="eyebrow">START WITH A QUESTION</span>
            <Title level={3}>你想先处理什么？</Title>
          </div>
          <Tag className="preview-tag">所有动作先预览</Tag>
        </div>
        <TextArea
          aria-label="经营问题"
          autoSize={isUnavailable ? false : { minRows: 5, maxRows: 8 }}
          disabled={isUnavailable}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例如：帮我看看本周有哪些待确认的课消……"
          value={prompt}
        />
        <div className="prompt-footer">
          <Text className="prompt-hint">
            {isUnavailable ? 'AI 恢复连接后，这里才会创建会话。' : '当前会先读取信息并生成 Preview。'}
          </Text>
          <Button disabled={isUnavailable || prompt.trim().length === 0} type="primary">
            生成预览 <span aria-hidden="true">↗</span>
          </Button>
        </div>
        <div className="suggestion-row" aria-label="示例入口">
          <span className="suggestion-label">可以从这里开始</span>
          {suggestions.map((suggestion) => (
            <button
              className="suggestion-button"
              disabled={isUnavailable}
              key={suggestion}
              onClick={() => setPrompt(suggestion)}
              type="button"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </Card>

      <section aria-labelledby="workflow-heading" className="workflow-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">SAFE WORKFLOW</span>
            <Title id="workflow-heading" level={3}>每一次操作都经过确认</Title>
          </div>
          <Text className="section-note">当前为产品骨架</Text>
        </div>
        <div className="workflow-steps">
          <WorkflowStep number="01" title="描述" detail="用自然语言说明目标" />
          <span className="step-arrow" aria-hidden="true">→</span>
          <WorkflowStep number="02" title="预览" detail="查看数据与计算依据" />
          <span className="step-arrow" aria-hidden="true">→</span>
          <WorkflowStep number="03" title="确认" detail="由 Core API 执行写入" />
        </div>
      </section>
    </section>
  );
}

function WorkflowStep({ detail, number, title }: { detail: string; number: string; title: string }) {
  return (
    <div className="workflow-step">
      <span className="step-number">{number}</span>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function ContextPanel() {
  return (
    <div className="context-inner">
      <div className="context-heading">
        <div>
          <span className="eyebrow">WORKSPACE CONTEXT</span>
          <Title level={3}>当前上下文</Title>
        </div>
        <button aria-label="清空上下文" className="clear-button" type="button">清空</button>
      </div>

      <div className="empty-context">
        <span className="empty-orbit" aria-hidden="true">＋</span>
        <strong>还没有选择对象</strong>
        <span>从对话或结构化入口选择学生、课程或业务日后，相关信息会出现在这里。</span>
      </div>

      <div className="boundary-card">
        <div className="boundary-title"><span className="boundary-icon">◌</span> AI 的安全边界</div>
        <ul>
          <li>只能查询和申请 Preview</li>
          <li>不能直接确认资金或课消</li>
          <li>写入由浏览器直接调用 Core</li>
        </ul>
      </div>

      <div className="context-meta">
        <span>数据连接</span>
        <strong>未建立</strong>
      </div>
      <div className="context-meta">
        <span>会话状态</span>
        <strong>尚未开始</strong>
      </div>
    </div>
  );
}

function StructuredFallback() {
  const location = useLocation();
  const section = location.pathname.split('/').at(-1);
  const title = section === 'students' ? '学生与账户' : section === 'schedule' ? '排课与课消' : '收支与报表';

  return (
    <section aria-labelledby="fallback-heading" className="fallback-view">
      <span className="eyebrow accent-eyebrow">STRUCTURED FALLBACK</span>
      <Title id="fallback-heading" level={1}>{title}</Title>
      <p className="intro-copy">这是 AI 暂不可用时的确定性入口位置。接入 Core API 后，这里只展示真实接口数据。</p>
      <Card className="fallback-card" variant="borderless">
        <div className="fallback-icon" aria-hidden="true">⌁</div>
        <Title level={3}>功能尚未接通</Title>
        <Text>当前没有业务数据，也不会用演示数据填充页面。</Text>
        <div className="fallback-boundary">
          <span className="status-dot" />
          Core API / OpenAPI Client 待接入
        </div>
        <Link className="fallback-link" to="/">返回 AI 工作台</Link>
      </Card>
    </section>
  );
}

export type { NavItem, AssistantState };
