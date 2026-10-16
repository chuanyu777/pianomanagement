import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ASSISTANT_CAPABILITY_HEADER,
  AssistantRunSchema,
  AssistantResumeRequestSchema,
  AssistantStartRequestSchema,
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

export interface AgentRuntimeClient {
  start(input: AgentRuntimeStartInput): Promise<AgentRuntimeRun>;
  resume(input: AgentRuntimeResumeInput): Promise<AgentRuntimeRun>;
  openEvents(input: AgentRuntimeEventsInput): Promise<AgentRuntimeEventStream>;
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

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      await response.body?.cancel();
      throw new ServiceUnavailableException(PUBLIC_UNAVAILABLE_MESSAGE);
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof BadGatewayException) {
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
