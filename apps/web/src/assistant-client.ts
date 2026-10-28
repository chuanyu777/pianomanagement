import type { components } from '@piano/generated-core-client/generated/core-api';
import {
  AssistantEventSchema,
  AssistantRunSchema,
  WorkspaceDocumentSchema,
  type AssistantEvent,
  type AssistantRun,
  type WorkspaceDocument as ProtocolWorkspaceDocument,
} from '@piano/assistant-protocol';

export type AssistantUiEvent = AssistantEvent;
export type AssistantRunStatus = AssistantRun['status'];
export type WorkspaceDocument = ProtocolWorkspaceDocument;
export type WorkspaceBlock = WorkspaceDocument['blocks'][number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_RUN_STATUSES = new Set<AssistantRunStatus>(['completed', 'failed']);
export const AUTH_EXPIRED_EVENT = 'pianomanager.authExpired';

export function notifyAuthExpired(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkspaceDocument(value: unknown): WorkspaceDocument | null {
  const parsed = WorkspaceDocumentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createAssistantIds(): { threadId: string; clientRequestId: string } {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('当前浏览器无法安全生成会话标识，请使用较新的浏览器重试。');
  }
  return { threadId: crypto.randomUUID(), clientRequestId: crypto.randomUUID() };
}

export function parseAssistantRun(value: unknown): AssistantRun | null {
  const parsed = AssistantRunSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
  if (eventName === 'workspace.replace') {
    const document = parseWorkspaceDocument(payload.document);
    if (!document) return null;
    return { type: eventName, document } as AssistantEvent;
  }
  const parsed = AssistantEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
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
  if (!input.token) {
    notifyAuthExpired();
    throw new Error('登录状态已失效，请重新登录后再试。');
  }
  const response = await (input.fetchImpl ?? fetch)('/api/assistant/runs', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${input.token}` },
    body: JSON.stringify({ message: input.message, threadId: input.threadId, clientRequestId: input.clientRequestId }),
  });
  if (!response.ok) {
    if (response.status === 401) {
      notifyAuthExpired();
      throw new Error('登录状态已失效，请重新登录后再试。');
    }
    if (response.status === 403) throw new Error('当前账号无权执行此操作。');
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
  if (!input.token) {
    notifyAuthExpired();
    throw new Error('登录状态已失效，请重新登录后再试。');
  }
  const response = await (input.fetchImpl ?? fetch)(`/api/assistant/runs/${input.run.runId}/events`, {
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${input.token}`,
      'x-thread-id': input.run.threadId,
    },
    signal: input.signal,
  });
  if (!response.ok) {
    if (response.status === 401) {
      notifyAuthExpired();
      throw new Error('登录状态已失效，请重新登录后再试。');
    }
    if (response.status === 403) throw new Error('当前账号无权执行此操作。');
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

export type AssistantPreviewStatus = components['schemas']['AssistantPreviewStateResponse']['status'];
export type AssistantPreview = {
  previewId: string;
  actionType: string;
  schemaVersion: string;
  riskLevel: components['schemas']['AssistantPreviewStateResponse']['riskLevel'];
  status: AssistantPreviewStatus;
  expiresAt: string;
  receipt: Record<string, unknown> | null;
  display?: Record<string, unknown>;
};

export type AssistantPreviewConfirmation = { previewId: string; status: 'EXECUTED'; receipt: Record<string, unknown> | null };
export type AssistantPreviewDraft = AssistantPreview & { display: Record<string, unknown> };

export class UnknownConfirmationError extends Error {
  readonly code = 'UNKNOWN_CONFIRMATION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnknownConfirmationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function parseAssistantPreview(value: unknown, expectedPreviewId: string): AssistantPreview | null {
  if (!isRecord(value) || value.previewId !== expectedPreviewId || !UUID_PATTERN.test(expectedPreviewId) ||
      typeof value.actionType !== 'string' || typeof value.schemaVersion !== 'string' ||
      (value.riskLevel !== 'L1' && value.riskLevel !== 'L2') ||
      !(['PENDING', 'EXECUTED', 'CANCELLED', 'EXPIRED', 'STALE'] as const).includes(value.status as AssistantPreviewStatus) ||
      typeof value.expiresAt !== 'string' || (value.receipt !== null && !isRecord(value.receipt)) ||
      (value.display !== undefined && !isRecord(value.display))) return null;
  return {
    previewId: expectedPreviewId,
    actionType: value.actionType,
    schemaVersion: value.schemaVersion,
    riskLevel: value.riskLevel,
    status: value.status as AssistantPreviewStatus,
    expiresAt: value.expiresAt,
    receipt: value.receipt as Record<string, unknown> | null,
    ...(isRecord(value.display) ? { display: value.display } : {}),
  };
}

export async function createAssistantPreview(input: {
  token: string | null;
  path: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<AssistantPreviewDraft> {
  if (!input.token) {
    notifyAuthExpired();
    throw new Error('登录状态已失效，请重新登录后再试。');
  }
  const response = await (input.fetchImpl ?? fetch)(`/api/assistant/previews/${input.path.replace(/^\//, '')}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${input.token}` },
    body: JSON.stringify(input.body),
  });
  if (!response.ok) {
    if (response.status === 401) { notifyAuthExpired(); throw new Error('登录状态已失效，请重新登录后再试。'); }
    if (response.status === 403) throw new Error('当前账号无权创建该预览。');
    if (response.status === 400 || response.status === 409) {
      const payload: unknown = await response.json().catch(() => null);
      if (isRecord(payload) && typeof payload.message === 'string' && payload.message.trim() && payload.message.length <= 500) throw new Error(payload.message);
    }
    throw new Error(`无法创建操作预览（HTTP ${response.status}），请检查输入后重试。`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.previewId !== 'string' || !UUID_PATTERN.test(payload.previewId) ||
      typeof payload.actionType !== 'string' || (payload.schemaVersion !== undefined && typeof payload.schemaVersion !== 'string') ||
      (payload.riskLevel !== 'L1' && payload.riskLevel !== 'L2') || typeof payload.expiresAt !== 'string' ||
      !isRecord(payload.display)) throw new Error('服务返回的预览格式无效，请稍后重试。');
  const preview = typeof payload.schemaVersion === 'string'
    ? parseAssistantPreview({ ...payload, status: 'PENDING', receipt: null }, payload.previewId)
    : await getAssistantPreview({ token: input.token, previewId: payload.previewId, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
  if (preview && (preview.actionType !== payload.actionType || preview.riskLevel !== payload.riskLevel)) {
    throw new Error('确认单信息不一致，请重新生成。');
  }
  if (!preview) throw new Error('服务返回的预览格式无效，请稍后重试。');
  return { ...preview, display: payload.display };
}

export async function getAssistantPreview(input: {
  token: string | null;
  previewId: string;
  fetchImpl?: typeof fetch;
}): Promise<AssistantPreview> {
  if (!input.token) {
    notifyAuthExpired();
    throw new Error('登录状态已失效，请重新登录后再试。');
  }
  if (!UUID_PATTERN.test(input.previewId)) throw new Error('预览标识无效，请重新生成预览。');
  const response = await (input.fetchImpl ?? fetch)(`/api/assistant/previews/${input.previewId}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${input.token}` },
  });
  if (!response.ok) {
    if (response.status === 401) {
      notifyAuthExpired();
      throw new Error('登录状态已失效，请重新登录后再试。');
    }
    if (response.status === 403) throw new Error('当前账号无权读取该预览。');
    if (response.status === 404) throw new Error('预览不存在或已无法访问，请重新生成预览。');
    throw new Error(`无法读取预览当前状态（HTTP ${response.status}），请稍后重查。`);
  }
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new Error('预览状态响应无法读取，请稍后重查。');
  }
  const preview = parseAssistantPreview(payload, input.previewId);
  if (!preview) throw new Error('预览响应格式无效，请刷新后重查。');
  return preview;
}

function confirmationFromPreview(preview: AssistantPreview): AssistantPreviewConfirmation {
  return { previewId: preview.previewId, status: 'EXECUTED', receipt: preview.receipt };
}

function previewStatusError(status: AssistantPreviewStatus): Error {
  if (status === 'CANCELLED') return new Error('预览已取消，未执行任何操作。');
  if (status === 'STALE') return new Error('预览已失效或已被其他请求确认，请重新生成预览。');
  if (status === 'EXPIRED') return new Error('预览已过期，未执行任何操作。请重新生成预览。');
  return new Error('预览当前不可确认，请先重查状态。');
}

async function recoverUnknownConfirmation(input: {
  token: string;
  previewId: string;
  fetchImpl?: typeof fetch;
  reason?: string;
}): Promise<AssistantPreviewConfirmation> {
  const reason = input.reason ? `${input.reason}；` : '';
  try {
    const current = await getAssistantPreview(input.fetchImpl
      ? { token: input.token, previewId: input.previewId, fetchImpl: input.fetchImpl }
      : { token: input.token, previewId: input.previewId });
    if (current.status === 'EXECUTED') return confirmationFromPreview(current);
    throw new UnknownConfirmationError(`${reason}确认请求结果未知，系统当前状态为 ${current.status}，未再次提交。请先重查预览状态。`);
  } catch (cause) {
    if (cause instanceof UnknownConfirmationError) throw cause;
    throw new UnknownConfirmationError(`${reason}确认请求结果未知，无法核对系统当前状态。请先重查预览状态后再决定是否重试。`);
  }
}

export async function confirmAssistantPreview(input: {
  token: string | null;
  previewId: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}): Promise<AssistantPreviewConfirmation> {
  if (!input.token) {
    notifyAuthExpired();
    throw new Error('登录状态已失效，请重新登录后再试。');
  }
  if (!UUID_PATTERN.test(input.previewId) || !UUID_PATTERN.test(input.idempotencyKey)) throw new Error('预览或确认标识无效，请重新生成预览。');
  const current = await getAssistantPreview(input.fetchImpl
    ? { token: input.token, previewId: input.previewId, fetchImpl: input.fetchImpl }
    : { token: input.token, previewId: input.previewId });
  if (current.status === 'EXECUTED') return confirmationFromPreview(current);
  if (current.status !== 'PENDING') throw previewStatusError(current.status);
  if (!Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) {
    throw new Error('预览已过期，未执行任何操作。请重新生成预览。');
  }
  const recover = () => input.fetchImpl
    ? recoverUnknownConfirmation({ token: input.token!, previewId: input.previewId, fetchImpl: input.fetchImpl })
    : recoverUnknownConfirmation({ token: input.token!, previewId: input.previewId });

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`/api/assistant/previews/${input.previewId}/confirm`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.token}`, 'Idempotency-Key': input.idempotencyKey },
    });
  } catch {
    return recover();
  }
  if (!response.ok) {
    if (response.status === 401) {
      notifyAuthExpired();
      throw new Error('登录状态已失效，请重新登录后再试。');
    }
    if (response.status === 403) throw new Error('当前账号无权确认该预览。');
    if (response.status === 409) {
      const payload: unknown = await response.json().catch(() => null);
      if (isRecord(payload) && typeof payload.message === 'string' && payload.message.trim() && payload.message.length <= 500) throw new Error(payload.message);
      throw new Error('预览已失效或已被其他请求确认，请重新生成预览。');
    }
    return recover();
  }
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    return recover();
  }
  if (!isRecord(payload) || payload.previewId !== input.previewId || payload.status !== 'EXECUTED' ||
      (payload.receipt !== null && !isRecord(payload.receipt))) {
    return input.fetchImpl
      ? recoverUnknownConfirmation({ token: input.token!, previewId: input.previewId, fetchImpl: input.fetchImpl, reason: '确认响应格式无效' })
      : recoverUnknownConfirmation({ token: input.token!, previewId: input.previewId, reason: '确认响应格式无效' });
  }
  return { previewId: input.previewId, status: 'EXECUTED', receipt: payload.receipt as Record<string, unknown> | null };
}
