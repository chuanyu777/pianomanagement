import { describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_CAPABILITY_HEADER,
  INTERNAL_REQUEST_NONCE_HEADER,
  INTERNAL_REQUEST_SIGNATURE_HEADER,
  INTERNAL_REQUEST_TIMESTAMP_HEADER,
} from '@piano/assistant-protocol';
import { verifySignedInternalRequest } from '@piano/assistant-protocol/internal-auth';
import { CoreToolClient } from '../src/tools/core-tool-client.js';

describe('CoreToolClient dashboard summary', () => {
  it('calls the read-only summary endpoint with the capability and a valid HMAC signature', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ businessDate: '2026-10-17', highlights: ['今日排课 4 节'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient(
      'http://core.test',
      1_000,
      'unit-test-secret-012345678901234567890123',
    );

    await expect(client.getDashboardSummary('short-lived-capability')).resolves.toEqual({
      businessDate: '2026-10-17',
      highlights: ['今日排课 4 节'],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(String(url)).toBe('http://core.test/tools/dashboard-summary');
    expect(headers.authorization).toBe('Bearer short-lived-capability');
    expect(
      verifySignedInternalRequest({
        secret: 'unit-test-secret-012345678901234567890123',
        timestamp: headers[INTERNAL_REQUEST_TIMESTAMP_HEADER]!,
        nonce: headers[INTERNAL_REQUEST_NONCE_HEADER]!,
        signature: headers[INTERNAL_REQUEST_SIGNATURE_HEADER]!,
        method: 'GET',
        path: '/tools/dashboard-summary',
        securityHeaders: { authorization: 'Bearer short-lived-capability' },
      }),
    ).toBe(true);
  });
});

describe('CoreToolClient teacher candidates', () => {
  const secret = 'unit-test-secret-012345678901234567890123';
  const candidates = {
    candidates: [
      { teacherId: '71726279-43f1-4fe6-9aa1-b12988812b5d', name: '王老师' },
    ],
  };

  it('uses the READ endpoint, URL-encodes the name, and signs the exact path and query', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(candidates), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient('http://core.test/api/internal', 1_000, secret);

    await expect(client.getTeacherCandidates('read-capability', { teacherName: ' 王老师 & 李老师 ' }))
      .resolves.toEqual(candidates);

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const path = '/api/internal/tools/teacher-candidates?teacherName=%E7%8E%8B%E8%80%81%E5%B8%88+%26+%E6%9D%8E%E8%80%81%E5%B8%88';
    expect(String(url)).toBe(`http://core.test${path}`);
    expect(init?.method).toBeUndefined();
    expect(headers.authorization).toBe('Bearer read-capability');
    expect(verifySignedInternalRequest({
      secret,
      timestamp: headers[INTERNAL_REQUEST_TIMESTAMP_HEADER]!,
      nonce: headers[INTERNAL_REQUEST_NONCE_HEADER]!,
      signature: headers[INTERNAL_REQUEST_SIGNATURE_HEADER]!,
      method: 'GET',
      path,
      securityHeaders: { authorization: 'Bearer read-capability' },
    })).toBe(true);
  });

  it('rejects malformed responses using a strict schema', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ ...candidates.candidates[0], role: 'OWNER' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient('http://core.test/api/internal', 1_000, secret);

    await expect(client.getTeacherCandidates('read-capability', { teacherName: '王老师' })).rejects.toThrow();
  });

  it.each(['   ', 'a'.repeat(101)])('rejects invalid teacher names before fetch: %j', async (teacherName) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient('http://core.test/api/internal', 1_000, secret);

    await expect(client.getTeacherCandidates('read-capability', { teacherName })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CoreToolClient single lesson Preview', () => {
  const secret = 'unit-test-secret-012345678901234567890123';
  const request = {
    accountId: '49fbcf47-c616-468a-a058-cdca1ee66025',
    teacherId: '71726279-43f1-4fe6-9aa1-b12988812b5d',
    startsAt: '2026-11-02T09:00:00+08:00',
    note: '周一课程',
    idempotencyKey: 'e244c3d5-6a58-4d4d-bc8f-f181cd3ab0aa',
    requestId: 'f77d8168-5d57-4e81-9c32-11e22e42b81c',
  };
  const preview = {
    previewId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90',
    actionType: 'lesson.schedule.single',
    command: {
      accountId: request.accountId,
      teacherId: request.teacherId,
      startsAt: '2026-11-02T01:00:00.000Z',
      endsAt: '2026-11-02T01:45:00.000Z',
      note: request.note,
    },
    display: { title: '单节排课', summary: '确认后创建一节排课记录。' },
    expiresAt: '2026-11-02T01:05:00.000Z',
  };

  it('posts the typed Preview request and signs its path, body and Capability Authorization', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(preview), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient('http://core.test/api/internal', 1_000, secret);

    await expect(client.createSingleLessonPreview('short-lived-capability', request)).resolves.toEqual(preview);

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as typeof request;
    expect(String(url)).toBe('http://core.test/api/internal/assistant-actions/lessons/single/preview');
    expect(init?.method).toBe('POST');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Bearer short-lived-capability');
    expect(headers[INTERNAL_REQUEST_TIMESTAMP_HEADER]).toMatch(/^\d+$/);
    expect(headers[INTERNAL_REQUEST_NONCE_HEADER]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(headers[INTERNAL_REQUEST_SIGNATURE_HEADER]).toBeTruthy();
    const signatureInput = {
      secret,
      timestamp: headers[INTERNAL_REQUEST_TIMESTAMP_HEADER]!,
      nonce: headers[INTERNAL_REQUEST_NONCE_HEADER]!,
      signature: headers[INTERNAL_REQUEST_SIGNATURE_HEADER]!,
      method: 'POST',
      path: '/api/internal/assistant-actions/lessons/single/preview',
      body,
      securityHeaders: {
        authorization: 'Bearer short-lived-capability',
        [ASSISTANT_CAPABILITY_HEADER]: undefined,
      },
    };
    expect(verifySignedInternalRequest(signatureInput)).toBe(true);
    expect(verifySignedInternalRequest({
      ...signatureInput,
      securityHeaders: { authorization: 'Bearer another-capability' },
    })).toBe(false);
    expect(verifySignedInternalRequest({ ...signatureInput, path: '/api/internal/assistant-actions/confirm' })).toBe(false);
  });

  it('rejects a Core response that does not match the Preview contract', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ...preview, actionType: 'refund.execute' }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient('http://core.test/api/internal', 1_000, secret);

    await expect(client.createSingleLessonPreview('short-lived-capability', request)).rejects.toThrow();
  });

  it('rejects malformed request fields before making a network request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient('http://core.test/api/internal', 1_000, secret);

    await expect(client.createSingleLessonPreview('short-lived-capability', {
      ...request,
      accountId: 'not-a-uuid',
    })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CoreToolClient course account Preview', () => {
  const secret = 'unit-test-secret-012345678901234567890123';
  const commonRequest = {
    accountId: '49fbcf47-c616-468a-a058-cdca1ee66025',
    amount: '1250.50',
    occurredAt: '2026-11-02T09:00:00+08:00',
    note: '11 月课程款',
    idempotencyKey: 'e244c3d5-6a58-4d4d-bc8f-f181cd3ab0aa',
    requestId: 'f77d8168-5d57-4e81-9c32-11e22e42b81c',
  };
  const balance = {
    accountId: commonRequest.accountId,
    paidBalance: '2500.50',
    giftBalance: '100.00',
    totalBalance: '2600.50',
  };
  const paymentPreview = {
    previewId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90',
    actionType: 'course-account.payment',
    command: {
      accountId: commonRequest.accountId,
      amount: commonRequest.amount,
      occurredAt: '2026-11-02T01:00:00.000Z',
      note: commonRequest.note,
      channel: 'WECHAT',
    },
    display: {
      title: '课程交费',
      summary: '交费 ¥1250.50',
      beforeBalance: balance,
      afterBalance: { ...balance, paidBalance: '3751.00', totalBalance: '3851.00' },
    },
    expiresAt: '2026-11-02T01:05:00.000Z',
    auditEventId: '428b354a-6f3f-4eb8-8d09-2c6c450f9ec8',
  };
  const giftPreview = {
    previewId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90',
    actionType: 'course-account.gift',
    command: {
      accountId: commonRequest.accountId,
      amount: commonRequest.amount,
      occurredAt: '2026-11-02T01:00:00.000Z',
      note: commonRequest.note,
    },
    display: {
      title: '课程赠送',
      summary: '赠送 ¥1250.50',
      beforeBalance: balance,
      afterBalance: { ...balance, giftBalance: '1350.50', totalBalance: '3851.00' },
    },
    expiresAt: '2026-11-02T01:05:00.000Z',
    auditEventId: '428b354a-6f3f-4eb8-8d09-2c6c450f9ec8',
  };

  it.each([
    {
      method: 'createPaymentPreview' as const,
      request: { ...commonRequest, channel: 'WECHAT' as const },
      response: paymentPreview,
      path: '/api/internal/assistant-actions/course-accounts/payment/preview',
    },
    {
      method: 'createGiftPreview' as const,
      request: commonRequest,
      response: giftPreview,
      path: '/api/internal/assistant-actions/course-accounts/gift/preview',
    },
  ])('posts and signs $path with the unchanged string amount', async ({ method, request, response, path }) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient('http://core.test/api/internal', 1_000, secret);

    await expect(client[method]('short-lived-capability', request)).resolves.toEqual(response);

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as typeof request;
    expect(String(url)).toBe(`http://core.test${path}`);
    expect(init?.method).toBe('POST');
    expect(body).toEqual(request);
    expect(typeof body.amount).toBe('string');
    expect(headers.authorization).toBe('Bearer short-lived-capability');
    expect(
      verifySignedInternalRequest({
        secret,
        timestamp: headers[INTERNAL_REQUEST_TIMESTAMP_HEADER]!,
        nonce: headers[INTERNAL_REQUEST_NONCE_HEADER]!,
        signature: headers[INTERNAL_REQUEST_SIGNATURE_HEADER]!,
        method: 'POST',
        path,
        body,
        securityHeaders: { authorization: 'Bearer short-lived-capability' },
      }),
    ).toBe(true);
  });

  it.each([
    {
      method: 'createPaymentPreview' as const,
      request: { ...commonRequest, channel: 'WECHAT' as const },
      response: { ...paymentPreview, actionType: 'course-account.gift' },
    },
    {
      method: 'createGiftPreview' as const,
      request: commonRequest,
      response: { ...giftPreview, command: { ...giftPreview.command, amount: 1250.5 } },
    },
  ])('rejects invalid $method responses using strict schema validation', async ({ method, request, response }) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient('http://core.test/api/internal', 1_000, secret);

    await expect(client[method]('short-lived-capability', request)).rejects.toThrow();
  });

  it.each([
    {
      method: 'createPaymentPreview' as const,
      request: { ...commonRequest, amount: 1250.5, channel: 'WECHAT' as const },
    },
    {
      method: 'createGiftPreview' as const,
      request: { ...commonRequest, amount: '0.00' },
    },
    {
      method: 'createPaymentPreview' as const,
      request: { ...commonRequest, channel: 'CASH' as const, unexpected: true },
    },
  ])('rejects malformed $method requests before network access', async ({ method, request }) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreToolClient('http://core.test/api/internal', 1_000, secret);

    await expect(client[method]('short-lived-capability', request)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
