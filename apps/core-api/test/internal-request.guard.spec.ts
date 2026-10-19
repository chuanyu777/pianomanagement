import type { ExecutionContext } from '@nestjs/common';
import { createSignedInternalRequestHeaders } from '@piano/assistant-protocol/internal-auth';
import { afterEach, describe, expect, it } from 'vitest';
import { InternalRequestGuard } from '../src/common/internal-auth/internal-request.guard.js';

const secret = 'stage-0-hmac-secret-012345678901234567890';

function contextFor(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('InternalRequestGuard', () => {
  const originalSecret = process.env['INTERNAL_SERVICE_SECRET'];

  afterEach(() => {
    if (originalSecret === undefined) delete process.env['INTERNAL_SERVICE_SECRET'];
    else process.env['INTERNAL_SERVICE_SECRET'] = originalSecret;
  });

  it('accepts one fresh signed request and rejects nonce replay', async () => {
    process.env['INTERNAL_SERVICE_SECRET'] = secret;
    const method = 'POST';
    const originalUrl = '/api/internal/assistant-actions/preview';
    const body = { idempotencyKey: 'one', requestId: 'request-one' };
    const headers = createSignedInternalRequestHeaders({
      secret,
      method,
      path: originalUrl,
      body,
      securityHeaders: { authorization: 'Bearer capability-a' },
    });
    headers['authorization'] = 'Bearer capability-a';
    const request = { method, originalUrl, body, headers };
    const guard = new InternalRequestGuard();

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow('服务鉴权失败');
  });

  it('rejects a signature when the body was changed', async () => {
    process.env['INTERNAL_SERVICE_SECRET'] = secret;
    const method = 'POST';
    const originalUrl = '/api/internal/assistant-actions/preview';
    const headers = createSignedInternalRequestHeaders({
      secret,
      method,
      path: originalUrl,
      body: { idempotencyKey: 'one' },
      securityHeaders: { authorization: 'Bearer capability-a' },
    });
    headers['authorization'] = 'Bearer capability-a';
    const guard = new InternalRequestGuard();

    await expect(
      guard.canActivate(
        contextFor({
          method,
          originalUrl,
          headers,
          body: { idempotencyKey: 'tampered' },
        }),
      ),
    ).rejects.toThrow('服务鉴权失败');
  });

  it('rejects a valid HMAC when the bearer Capability changes', async () => {
    process.env['INTERNAL_SERVICE_SECRET'] = secret;
    const method = 'GET';
    const originalUrl = '/api/internal/tools/system-status';
    const headers = createSignedInternalRequestHeaders({
      secret,
      method,
      path: originalUrl,
      securityHeaders: { authorization: 'Bearer capability-a' },
    });
    headers['authorization'] = 'Bearer capability-b';
    const guard = new InternalRequestGuard();

    await expect(
      guard.canActivate(contextFor({ method, originalUrl, headers })),
    ).rejects.toThrow('服务鉴权失败');
  });
});
