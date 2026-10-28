import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  GatewayTimeoutException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ASSISTANT_CAPABILITY_HEADER,
  AssistantRunSchema,
  AssistantResumeRequestSchema,
  AssistantStartRequestSchema,
  HistoricalPreviewReferenceSchema,
  WorkspaceDocumentSchema,
  type AssistantResumeInput,
} from '@piano/assistant-protocol';
import { createSignedInternalRequestHeaders } from '@piano/assistant-protocol/internal-auth';
import { z } from 'zod';

export const AgentRuntimeRunSchema = AssistantRunSchema;
export type AgentRuntimeRun = z.infer<typeof AssistantRunSchema>;

export type AgentRuntimeStartInput = {
  runId: string;
  threadId: string;
  message: string;
  clientRequestId?: string;
  traceId?: string;
  capability: string;
};

export type AgentRuntimeResumeInput = {
  runId: string;
  threadId: string;
  input: AssistantResumeInput;
  traceId?: string;
  capability: string;
};

export type AgentRuntimeEventsInput = {
  runId: string;
  lastEventId?: string;
  traceId?: string;
  capability: string;
};

export type AgentRuntimeEventStream = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
};

const AgentThreadSummarySchema = z.object({
  threadId: z.string().uuid(), title: z.string(), lastActivityAt: z.string().datetime(), latestStatus: z.enum(['queued', 'running', 'waiting_for_input', 'completed', 'failed']).nullable(),
});
const AgentThreadDetailSchema = AgentThreadSummarySchema.extend({
  messages: z.array(z.object({ id: z.string().uuid(), role: z.enum(['user', 'assistant']), content: z.string(), createdAt: z.string().datetime() })),
  workspace: WorkspaceDocumentSchema.nullable(),
  historicalPreviews: z.array(HistoricalPreviewReferenceSchema).default([]),
});
export type AgentThreadSummary = z.infer<typeof AgentThreadSummarySchema>;
export type AgentThreadDetail = z.infer<typeof AgentThreadDetailSchema>;

export interface AgentRuntimeClient {
  start(input: AgentRuntimeStartInput): Promise<AgentRuntimeRun>;
  resume(input: AgentRuntimeResumeInput): Promise<AgentRuntimeRun>;
  openEvents(input: AgentRuntimeEventsInput): Promise<AgentRuntimeEventStream>;
  listThreads(input: { capability: string; limit?: number; traceId?: string }): Promise<AgentThreadSummary[]>;
  getThread(input: { capability: string; threadId: string; traceId?: string }): Promise<AgentThreadDetail>;
}
export const AGENT_RUNTIME_CLIENT = Symbol('AGENT_RUNTIME_CLIENT');

export type HttpAgentRuntimeClientOptions = {
  baseUrl: string;
  serviceSecret: string;
  timeoutMs: number;
  streamIdleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const PUBLIC_UNAVAILABLE_MESSAGE = 'AI 助手服务暂时不可用，请稍后重试';
const PUBLIC_TIMEOUT_MESSAGE = 'AI 助手响应超时，请稍后重试';
const PUBLIC_PROTOCOL_MESSAGE = 'AI 助手返回了无效响应，请稍后重试';

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function assertUuid(value: string): void {
  if (!z.string().uuid().safeParse(value).success) {
    throw new BadGatewayException(PUBLIC_PROTOCOL_MESSAGE);
  }
}

function assertEventCursor(value: string): void {
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new BadGatewayException(PUBLIC_PROTOCOL_MESSAGE);
  }
}

@Injectable()
export class HttpAgentRuntimeClient implements AgentRuntimeClient {
  readonly #baseUrl: string;
  readonly #serviceSecret: string;
  readonly #timeoutMs: number;
  readonly #streamIdleTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpAgentRuntimeClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#serviceSecret = options.serviceSecret;
    this.#timeoutMs = options.timeoutMs;
    this.#streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async start(input: AgentRuntimeStartInput): Promise<AgentRuntimeRun> {
    assertUuid(input.runId);
    assertUuid(input.threadId);

    const body = AssistantStartRequestSchema.parse({
      runId: input.runId,
      threadId: input.threadId,
      userMessage: input.message,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    });

    return this.postJson('/internal/assistant/runs/start', body, input.capability, input.traceId);
  }

  async resume(input: AgentRuntimeResumeInput): Promise<AgentRuntimeRun> {
    assertUuid(input.runId);
    assertUuid(input.threadId);

    return this.postJson(
      `/internal/assistant/runs/${encodeURIComponent(input.runId)}/resume`,
      AssistantResumeRequestSchema.parse({
        threadId: input.threadId,
        input: input.input,
      }),
      input.capability,
      input.traceId,
    );
  }

  async openEvents(input: AgentRuntimeEventsInput): Promise<AgentRuntimeEventStream> {
    assertUuid(input.runId);
    if (input.lastEventId !== undefined) assertEventCursor(input.lastEventId);
    const url = `${this.#baseUrl}/internal/assistant/runs/${encodeURIComponent(input.runId)}/events`;
    const headers = this.headers(
      url,
      'GET',
      input.capability,
      input.traceId,
      'text/event-stream',
      undefined,
      input.lastEventId === undefined ? {} : { 'last-event-id': input.lastEventId },
    );
    if (input.lastEventId !== undefined) {
      (headers as Record<string, string>)['last-event-id'] = input.lastEventId;
    }
    const response = await this.request(
      url,
      {
        method: 'GET',
        headers,
      },
    );

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('text/event-stream')) {
      await response.body?.cancel();
      throw new BadGatewayException(PUBLIC_PROTOCOL_MESSAGE);
    }
    if (!response.body) throw new BadGatewayException(PUBLIC_PROTOCOL_MESSAGE);

    return {
      body: this.withIdleTimeout(response.body),
      contentType: 'text/event-stream',
    };
  }

  listThreads(input: { capability: string; limit?: number; traceId?: string }): Promise<AgentThreadSummary[]> {
    const limit = input.limit ?? 12;
    return this.getJson(`/internal/assistant/threads?limit=${limit}`, input.capability, z.array(AgentThreadSummarySchema), input.traceId);
  }

  getThread(input: { capability: string; threadId: string; traceId?: string }): Promise<AgentThreadDetail> {
    assertUuid(input.threadId);
    return this.getJson(`/internal/assistant/threads/${encodeURIComponent(input.threadId)}`, input.capability, AgentThreadDetailSchema, input.traceId, { hideTaskExistence: true });
  }

  private async getJson<T>(path: string, capability: string, schema: z.ZodType<T>, traceId?: string, options?: { hideTaskExistence?: boolean }): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const response = await this.request(url, { method: 'GET', headers: this.headers(url, 'GET', capability, traceId, 'application/json') }, options);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new BadGatewayException(PUBLIC_PROTOCOL_MESSAGE); }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new BadGatewayException(PUBLIC_PROTOCOL_MESSAGE);
    return parsed.data;
  }

  private async postJson(
    path: string,
    body: unknown,
    capability: string,
    traceId?: string,
  ): Promise<AgentRuntimeRun> {
    const url = `${this.#baseUrl}${path}`;
    const response = await this.request(url, {
      method: 'POST',
      headers: this.headers(url, 'POST', capability, traceId, 'application/json', body),
      body: JSON.stringify(body),
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BadGatewayException(PUBLIC_PROTOCOL_MESSAGE);
    }

    const parsed = AgentRuntimeRunSchema.safeParse(payload);
    if (!parsed.success) throw new BadGatewayException(PUBLIC_PROTOCOL_MESSAGE);
    return parsed.data;
  }

  private headers(
    url: string,
    method: string,
    capability: string,
    traceId: string | undefined,
    accept: string,
    body?: unknown,
    additionalSecurityHeaders: Record<string, string> = {},
  ): HeadersInit {
    const target = new URL(url);
    const headers: Record<string, string> = {
      accept,
      [ASSISTANT_CAPABILITY_HEADER]: capability,
      ...createSignedInternalRequestHeaders({
        secret: this.#serviceSecret,
        method,
        path: `${target.pathname}${target.search}`,
        body,
        securityHeaders: {
          [ASSISTANT_CAPABILITY_HEADER]: capability,
          ...additionalSecurityHeaders,
        },
      }),
    };
    if (accept === 'application/json') headers['content-type'] = 'application/json';
    if (traceId) headers['x-trace-id'] = traceId;
    return headers;
  }

  private async request(url: string, init: RequestInit, options?: { hideTaskExistence?: boolean }): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      await response.body?.cancel();
      if (options?.hideTaskExistence && (response.status === 403 || response.status === 404)) {
        throw new NotFoundException('任务不存在或当前账号无权访问，请返回任务列表查看可用任务。');
      }
      if (response.status === 403) throw new ForbiddenException('当前账号无权访问该AI任务，请新建会话。');
      if (response.status === 409) throw new ConflictException('AI任务状态已变化，请重新核对。');
      throw new ServiceUnavailableException(PUBLIC_UNAVAILABLE_MESSAGE);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (isAbortError(error)) throw new GatewayTimeoutException(PUBLIC_TIMEOUT_MESSAGE);
      throw new ServiceUnavailableException(PUBLIC_UNAVAILABLE_MESSAGE);
    } finally {
      clearTimeout(timeout);
    }
  }

  private withIdleTimeout(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const idleTimeoutMs = this.#streamIdleTimeoutMs;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new GatewayTimeoutException(PUBLIC_TIMEOUT_MESSAGE)),
                idleTimeoutMs,
              );
            }),
          ]);
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          await reader.cancel();
          controller.error(error);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }
}
