import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AssistantEventSchema,
  encodeSseEvent,
  type AssistantResumeInput,
} from '@piano/assistant-protocol';
import { CapabilityTokenService } from '../../common/capability/capability-token.service.js';
import {
  AGENT_RUNTIME_CLIENT,
  type AgentRuntimeClient,
  type AgentRuntimeEventStream,
  type AgentRuntimeRun,
} from './agent-runtime.client.js';

const CAPABILITY_TTL_SECONDS = 300;
const SAFE_STREAM_ERROR = {
  type: 'run.failed' as const,
  code: 'AGENT_RUNTIME_UNAVAILABLE',
  message: 'AI 助手服务暂时不可用，请稍后重试',
  retryable: true,
};

export type StartAssistantRunInput = {
  userId: string;
  threadId?: string;
  message: string;
  clientRequestId?: string;
  traceId?: string;
};

export type ResumeAssistantRunInput = {
  userId: string;
  threadId: string;
  runId: string;
  input: AssistantResumeInput;
  traceId?: string;
};

export type OpenAssistantEventsInput = {
  userId: string;
  threadId: string;
  runId: string;
  traceId?: string;
};

export type AssistantSseProxy = {
  body: ReadableStream<Uint8Array>;
  contentType: 'text/event-stream';
  cacheControl: 'no-cache, no-transform';
};

@Injectable()
export class AssistantGatewayService {
  constructor(
    @Inject(AGENT_RUNTIME_CLIENT) private readonly agentRuntime: AgentRuntimeClient,
    private readonly capabilities: CapabilityTokenService,
  ) {}

  async startRun(input: StartAssistantRunInput): Promise<AgentRuntimeRun> {
    const runId = randomUUID();
    const threadId = input.threadId ?? randomUUID();
    const capability = this.issueCapability(input.userId, threadId, runId);
    try {
      const result = await this.agentRuntime.start({
        runId,
        threadId,
        message: input.message,
        capability,
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
      });
      return this.assertRunIdentity(result, runId);
    } catch (error) {
      throw this.toPublicError(error);
    }
  }

  async resumeRun(input: ResumeAssistantRunInput): Promise<AgentRuntimeRun> {
    const capability = this.issueCapability(input.userId, input.threadId, input.runId);
    try {
      const result = await this.agentRuntime.resume({
        runId: input.runId,
        threadId: input.threadId,
        input: input.input,
        capability,
        ...(input.traceId ? { traceId: input.traceId } : {}),
      });
      return this.assertRunIdentity(result, input.runId);
    } catch (error) {
      throw this.toPublicError(error);
    }
  }

  async openRunEvents(input: OpenAssistantEventsInput): Promise<AssistantSseProxy> {
    const capability = this.issueCapability(input.userId, input.threadId, input.runId);
    let upstream: AgentRuntimeEventStream;
    try {
      upstream = await this.agentRuntime.openEvents({
        runId: input.runId,
        capability,
        ...(input.traceId ? { traceId: input.traceId } : {}),
      });
    } catch (error) {
      throw this.toPublicError(error);
    }

    return {
      body: this.createSafeSseStream(upstream.body),
      contentType: 'text/event-stream',
      cacheControl: 'no-cache, no-transform',
    };
  }

  private issueCapability(userId: string, threadId: string, runId: string): string {
    return this.capabilities.issue({
      userId,
      threadId,
      runId,
      ttlSeconds: CAPABILITY_TTL_SECONDS,
      permissions: ['READ'],
    });
  }

  private assertRunIdentity(result: AgentRuntimeRun, expectedRunId: string): AgentRuntimeRun {
    if (result.runId !== expectedRunId) {
      throw new BadGatewayException('AI 助手返回了无效响应，请稍后重试');
    }
    return result;
  }

  private toPublicError(error: unknown): Error {
    if (error instanceof HttpException) return error;
    return new ServiceUnavailableException('AI 助手服务暂时不可用，请稍后重试');
  }

  private createSafeSseStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    const emitFailure = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(encoder.encode(encodeSseEvent(SAFE_STREAM_ERROR)));
      controller.close();
    };

    const consumeFrame = (frame: string): Uint8Array | undefined => {
      const normalized = frame.replace(/\r\n/g, '\n');
      const lines = normalized.split('\n');
      let eventName: string | undefined;
      const data: string[] = [];
      for (const line of lines) {
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? '' : line.slice(separator + 1).trimStart();
        if (field === 'event') eventName = value;
        if (field === 'data') data.push(value);
      }
      if (data.length === 0) return undefined;

      const event = AssistantEventSchema.parse(JSON.parse(data.join('\n')));
      if (eventName && eventName !== event.type) throw new Error('SSE event mismatch');
      return encoder.encode(encodeSseEvent(event));
    };

    return new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            while (true) {
              const result = await reader.read();
              if (result.done) break;
              buffer += decoder.decode(result.value, { stream: true });
              let separator = buffer.search(/\r?\n\r?\n/);
              while (separator >= 0) {
                const frame = buffer.slice(0, separator);
                buffer = buffer.slice(separator).replace(/^\r?\n\r?\n/, '');
                const output = consumeFrame(frame);
                if (output) controller.enqueue(output);
                separator = buffer.search(/\r?\n\r?\n/);
              }
            }
            buffer += decoder.decode();
            if (buffer.trim()) {
              const output = consumeFrame(buffer);
              if (output) controller.enqueue(output);
            }
            controller.close();
          } catch {
            emitFailure(controller);
          } finally {
            await reader.cancel();
          }
        })();
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }
}
