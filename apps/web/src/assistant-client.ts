export type AssistantRunStatus = 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed';

export type AssistantRun = {
  runId: string;
  threadId: string;
  status: AssistantRunStatus;
};

export type WorkspaceBlock =
  | { type: 'summary'; title: string; text: string }
  | { type: 'alert-list'; alerts: { severity: 'info' | 'warning' | 'error'; title: string; detail?: string }[] }
  | { type: 'metric-grid'; metrics: { label: string; value: string; tone: 'neutral' | 'positive' | 'warning' }[] }
  | { type: 'calculation-breakdown'; title: string; lines: { label: string; amount: string }[]; total: string }
  | { type: 'action-preview'; previewId: string; actionType: string; schemaVersion: string; title: string; riskLevel: 'L1' | 'L2'; expiresAt: string };

export type WorkspaceDocument = { protocolVersion: '1.0'; title: string; blocks: WorkspaceBlock[] };

export type AssistantUiEvent =
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; messageId: string; markdown: string }
  | { type: 'workspace.replace'; document: WorkspaceDocument }
  | { type: 'clarification.requested'; question: string }
  | { type: 'run.completed'; runId: string }
  | { type: 'run.failed'; code: string; message: string; retryable: boolean };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_RUN_STATUSES = new Set<AssistantRunStatus>(['completed', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkspaceDocument(value: unknown): WorkspaceDocument | null {
  if (!isRecord(value) || value.protocolVersion !== '1.0' || typeof value.title !== 'string' ||
      value.title.trim().length === 0 || !Array.isArray(value.blocks)) return null;

  const blocks: WorkspaceBlock[] = [];
  for (const rawBlock of value.blocks) {
    if (!isRecord(rawBlock) || typeof rawBlock.type !== 'string') continue;
    if (rawBlock.type === 'summary') {
      if (typeof rawBlock.title !== 'string' || rawBlock.title.trim().length === 0 || typeof rawBlock.text !== 'string') return null;
      blocks.push({ type: 'summary', title: rawBlock.title, text: rawBlock.text });
    } else if (rawBlock.type === 'alert-list') {
      if (!Array.isArray(rawBlock.alerts)) return null;
      const alerts: Extract<WorkspaceBlock, { type: 'alert-list' }>['alerts'] = [];
      for (const rawAlert of rawBlock.alerts) {
        if (!isRecord(rawAlert) || !['info', 'warning', 'error'].includes(String(rawAlert.severity)) ||
            typeof rawAlert.title !== 'string' || rawAlert.title.trim().length === 0 ||
            (rawAlert.detail !== undefined && typeof rawAlert.detail !== 'string')) return null;
        alerts.push({
          severity: rawAlert.severity as 'info' | 'warning' | 'error',
          title: rawAlert.title,
          ...(typeof rawAlert.detail === 'string' ? { detail: rawAlert.detail } : {}),
        });
      }
      blocks.push({ type: 'alert-list', alerts });
    } else if (rawBlock.type === 'metric-grid') {
      if (!Array.isArray(rawBlock.metrics)) return null;
      const metrics: Extract<WorkspaceBlock, { type: 'metric-grid' }>['metrics'] = [];
      for (const rawMetric of rawBlock.metrics) {
        if (!isRecord(rawMetric) || typeof rawMetric.label !== 'string' || rawMetric.label.trim().length === 0 ||
            typeof rawMetric.value !== 'string' ||
            (rawMetric.tone !== undefined && !['neutral', 'positive', 'warning'].includes(String(rawMetric.tone)))) return null;
        metrics.push({
          label: rawMetric.label,
          value: rawMetric.value,
          tone: (rawMetric.tone ?? 'neutral') as 'neutral' | 'positive' | 'warning',
        });
      }
      blocks.push({ type: 'metric-grid', metrics });
    } else if (rawBlock.type === 'calculation-breakdown') {
      if (typeof rawBlock.title !== 'string' || rawBlock.title.trim().length === 0 || !Array.isArray(rawBlock.lines) ||
          typeof rawBlock.total !== 'string' || !/^-?(0|[1-9]\d*)\.\d{2}$/.test(rawBlock.total)) return null;
      const lines: Extract<WorkspaceBlock, { type: 'calculation-breakdown' }>['lines'] = [];
      for (const rawLine of rawBlock.lines) {
        if (!isRecord(rawLine) || typeof rawLine.label !== 'string' || rawLine.label.trim().length === 0 ||
            typeof rawLine.amount !== 'string' || !/^-?(0|[1-9]\d*)\.\d{2}$/.test(rawLine.amount)) return null;
        lines.push({ label: rawLine.label, amount: rawLine.amount });
      }
      blocks.push({ type: 'calculation-breakdown', title: rawBlock.title, lines, total: rawBlock.total });
    } else if (rawBlock.type === 'action-preview') {
      if (typeof rawBlock.previewId !== 'string' || !UUID_PATTERN.test(rawBlock.previewId) ||
          typeof rawBlock.actionType !== 'string' || rawBlock.actionType.trim().length === 0 ||
          typeof rawBlock.schemaVersion !== 'string' || rawBlock.schemaVersion.trim().length === 0 ||
          typeof rawBlock.title !== 'string' || rawBlock.title.trim().length === 0 ||
          !['L1', 'L2'].includes(String(rawBlock.riskLevel)) || typeof rawBlock.expiresAt !== 'string' ||
          Number.isNaN(Date.parse(rawBlock.expiresAt))) return null;
      blocks.push({ type: 'action-preview', previewId: rawBlock.previewId, actionType: rawBlock.actionType,
        schemaVersion: rawBlock.schemaVersion, title: rawBlock.title, riskLevel: rawBlock.riskLevel as 'L1' | 'L2', expiresAt: rawBlock.expiresAt });
    }
  }
  return { protocolVersion: '1.0', title: value.title, blocks };
}

export function createAssistantIds(): { threadId: string; clientRequestId: string } {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('当前浏览器无法安全生成会话标识，请使用较新的浏览器重试。');
  }
  return { threadId: crypto.randomUUID(), clientRequestId: crypto.randomUUID() };
}

export function parseAssistantRun(value: unknown): AssistantRun | null {
  if (!isRecord(value) || typeof value.runId !== 'string' || !UUID_PATTERN.test(value.runId) ||
      typeof value.threadId !== 'string' || !UUID_PATTERN.test(value.threadId) ||
      !['queued', 'running', 'waiting_for_input', 'completed', 'failed'].includes(String(value.status))) {
    return null;
  }
  return value as AssistantRun;
}

export function parseAssistantSseFrame(frame: string): AssistantUiEvent | null {
  const fields = frame.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of fields) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    if (field === 'data') data.push(value);
  }
  if (!eventName || data.length === 0) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(data.join('\n')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload) || payload.type !== eventName) return null;

  switch (eventName) {
    case 'assistant.delta':
      return typeof payload.text === 'string' ? { type: eventName, text: payload.text } : null;
    case 'assistant.message':
      return typeof payload.messageId === 'string' && UUID_PATTERN.test(payload.messageId) && typeof payload.markdown === 'string'
        ? { type: eventName, messageId: payload.messageId, markdown: payload.markdown }
        : null;
    case 'workspace.replace': {
      const document = parseWorkspaceDocument(payload.document);
      return document ? { type: eventName, document } : null;
    }
    case 'clarification.requested':
      return typeof payload.question === 'string' && payload.question.trim().length > 0
        ? { type: eventName, question: payload.question }
        : null;
    case 'run.completed':
      return typeof payload.runId === 'string' && UUID_PATTERN.test(payload.runId)
        ? { type: eventName, runId: payload.runId }
        : null;
    case 'run.failed':
      return typeof payload.code === 'string' && payload.code.length > 0 && typeof payload.message === 'string' &&
          payload.message.length > 0 && typeof payload.retryable === 'boolean'
        ? { type: eventName, code: payload.code, message: payload.message, retryable: payload.retryable }
        : null;
    default:
      return null;
  }
}

export function isTerminalAssistantEvent(event: AssistantUiEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed';
}

export async function startAssistantRun(input: {
  token: string | null;
  message: string;
  threadId: string;
  clientRequestId: string;
  fetchImpl?: typeof fetch;
}): Promise<AssistantRun> {
  if (!input.token) throw new Error('登录状态已失效，请重新登录后再试。');
  const response = await (input.fetchImpl ?? fetch)('/api/assistant/runs', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${input.token}` },
    body: JSON.stringify({ message: input.message, threadId: input.threadId, clientRequestId: input.clientRequestId }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('登录状态已失效，请重新登录后再试。');
    throw new Error(`无法创建 AI 运行（HTTP ${response.status}），请检查连接后重试。`);
  }
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new Error('服务返回了无法读取的运行信息，请稍后重试。');
  }
  const run = parseAssistantRun(payload);
  if (!run || run.threadId !== input.threadId) throw new Error('服务返回的运行信息无效，请稍后重试。');
  return run;
}

export async function streamAssistantEvents(input: {
  token: string | null;
  run: AssistantRun;
  signal: AbortSignal;
  onEvent: (event: AssistantUiEvent) => boolean | void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!input.token) throw new Error('登录状态已失效，请重新登录后再试。');
  const response = await (input.fetchImpl ?? fetch)(`/api/assistant/runs/${input.run.runId}/events`, {
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${input.token}`,
      'x-thread-id': input.run.threadId,
    },
    signal: input.signal,
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('登录状态已失效，请重新登录后再试。');
    throw new Error(`AI 事件连接失败（HTTP ${response.status}），请稍后重试。`);
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) {
    throw new Error('AI 事件连接返回格式无效，请稍后重试。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stoppedByEvent = false;
  const deliverFrames = async (final = false) => {
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const event = parseAssistantSseFrame(frame);
      if (event && input.onEvent(event) === true) {
        stoppedByEvent = true;
        await reader.cancel();
        return;
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }
    if (final && buffer.trim()) {
      const event = parseAssistantSseFrame(buffer);
      buffer = '';
      if (event && input.onEvent(event) === true) {
        stoppedByEvent = true;
        await reader.cancel();
      }
    }
  };

  try {
    while (!stoppedByEvent) {
      if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        await deliverFrames(true);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      await deliverFrames();
    }
  } finally {
    if (!stoppedByEvent) await reader.cancel().catch(() => undefined);
  }
}

export function isTerminalRunStatus(status: AssistantRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export type AssistantPreviewConfirmation = { previewId: string; status: 'EXECUTED'; receipt: Record<string, unknown> | null };

export async function confirmAssistantPreview(input: {
  token: string | null;
  previewId: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}): Promise<AssistantPreviewConfirmation> {
  if (!input.token) throw new Error('登录状态已失效，请重新登录后再试。');
  if (!UUID_PATTERN.test(input.previewId) || !UUID_PATTERN.test(input.idempotencyKey)) throw new Error('预览或确认标识无效，请重新生成预览。');
  const response = await (input.fetchImpl ?? fetch)(`/api/assistant/previews/${input.previewId}/confirm`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${input.token}`, 'Idempotency-Key': input.idempotencyKey },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('登录状态已失效或无权确认该预览。');
    if (response.status === 409) throw new Error('预览已失效或已被其他请求确认，请重新生成预览。');
    throw new Error(`确认失败（HTTP ${response.status}），请稍后重试。`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.previewId !== input.previewId || payload.status !== 'EXECUTED' ||
      (payload.receipt !== null && !isRecord(payload.receipt))) throw new Error('确认响应格式无效，请刷新后核对业务结果。');
  return { previewId: input.previewId, status: 'EXECUTED', receipt: payload.receipt as Record<string, unknown> | null };
}
