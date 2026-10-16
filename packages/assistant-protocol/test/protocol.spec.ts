import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CAPABILITY_HEADER,
  AssistantEventSchema,
  AssistantResumeRequestSchema,
  AssistantStartRequestSchema,
  INTERNAL_REQUEST_NONCE_HEADER,
  INTERNAL_REQUEST_SIGNATURE_HEADER,
  INTERNAL_REQUEST_TIMESTAMP_HEADER,
  MoneyStringSchema,
  WorkspaceDocumentSchema,
  encodeSseEvent,
} from '../src/index.js';
import {
  InternalRequestReplayProtector,
  createSignedInternalRequestHeaders,
  createInternalRequestSignature,
  verifySignedInternalRequest,
  verifyInternalRequestSignature,
} from '../src/internal-auth.js';

describe('assistant protocol', () => {
  it('accepts fixed-point money strings and rejects JS-style shorthand', () => {
    expect(MoneyStringSchema.parse('200.00')).toBe('200.00');
    expect(() => MoneyStringSchema.parse('200')).toThrow();
    expect(() => MoneyStringSchema.parse('0.1')).toThrow();
  });

  it('rejects unknown workspace components', () => {
    expect(() =>
      WorkspaceDocumentSchema.parse({
        protocolVersion: '1.0',
        title: '测试',
        blocks: [{ type: 'html', html: '<button>执行</button>' }],
      }),
    ).toThrow();
    expect(() =>
      WorkspaceDocumentSchema.parse({
        protocolVersion: '1.0',
        title: '测试',
        blocks: [{ type: 'markdown', markdown: '旧协议组件' }],
      }),
    ).toThrow();
  });

  it('encodes a validated SSE event', () => {
    const event = AssistantEventSchema.parse({
      type: 'run.completed',
      runId: 'd80c49ef-e453-42f2-b20d-016f72c64959',
    });
    expect(encodeSseEvent(event)).toContain('event: run.completed');
  });

  it('defines one internal start/resume contract and separate authentication headers', () => {
    expect(AssistantStartRequestSchema.parse({
      runId: 'd80c49ef-e453-42f2-b20d-016f72c64959',
      threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      userMessage: '查询今天的排课',
      clientRequestId: 'request-1',
    })).toMatchObject({ userMessage: '查询今天的排课' });
    expect(AssistantResumeRequestSchema.parse({
      threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      input: { approved: true },
    })).toEqual({
      threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      input: { approved: true },
    });
    expect(ASSISTANT_CAPABILITY_HEADER).toBe('x-assistant-capability');
  });

  it('signs the complete internal request envelope and rejects tampering', () => {
    const input = {
      secret: 'stage-0-hmac-secret-01234567890123456789',
      timestamp: '1792108800',
      nonce: 'f5ea92cf-e736-4f02-ac40-2876cfdf1944',
      method: 'POST',
      path: '/internal/assistant/runs/start',
      body: '{"runId":"d80c49ef-e453-42f2-b20d-016f72c64959"}',
    };
    const signature = createInternalRequestSignature(input);

    expect(INTERNAL_REQUEST_TIMESTAMP_HEADER).toBe('x-internal-timestamp');
    expect(INTERNAL_REQUEST_NONCE_HEADER).toBe('x-internal-nonce');
    expect(INTERNAL_REQUEST_SIGNATURE_HEADER).toBe('x-internal-signature');
    expect(verifyInternalRequestSignature({ ...input, signature })).toBe(true);
    expect(
      verifyInternalRequestSignature({ ...input, body: '{"tampered":true}', signature }),
    ).toBe(false);
  });

  it('rejects expired and replayed signed internal requests', () => {
    const now = new Date('2026-10-16T00:00:00.000Z');
    const secret = 'stage-0-hmac-secret-01234567890123456789';
    const request = {
      method: 'POST',
      path: '/internal/assistant/runs/start',
      body: { threadId: 'a', runId: 'b' },
    };
    const headers = createSignedInternalRequestHeaders({ ...request, secret, now });
    const verification = {
      ...request,
      secret,
      now,
      timestamp: headers[INTERNAL_REQUEST_TIMESTAMP_HEADER]!,
      nonce: headers[INTERNAL_REQUEST_NONCE_HEADER]!,
      signature: headers[INTERNAL_REQUEST_SIGNATURE_HEADER]!,
    };
    const replay = new InternalRequestReplayProtector();

    expect(verifySignedInternalRequest(verification)).toBe(true);
    expect(replay.consume(verification.nonce, now)).toBe(true);
    expect(replay.consume(verification.nonce, now)).toBe(false);
    expect(
      verifySignedInternalRequest({
        ...verification,
        now: new Date(now.getTime() + 301_000),
      }),
    ).toBe(false);
  });

  it('uses only frozen event names in the stage 0 subset', () => {
    expect(AssistantEventSchema.safeParse({ type: 'assistant.delta', text: '你好' }).success).toBe(true);
    expect(
      AssistantEventSchema.safeParse({
        type: 'clarification.requested',
        question: '是否继续？',
      }).success,
    ).toBe(true);
    expect(AssistantEventSchema.safeParse({ type: 'answer.delta', text: '旧事件' }).success).toBe(false);
    expect(
      AssistantEventSchema.safeParse({ type: 'run.waiting_for_input', reason: 'confirmation' }).success,
    ).toBe(false);
  });
});
