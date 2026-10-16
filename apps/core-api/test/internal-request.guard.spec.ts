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

  it('accepts one fresh signed request and rejects nonce replay', () => {
    process.env['INTERNAL_SERVICE_SECRET'] = secret;
    const method = 'POST';
    const originalUrl = '/api/internal/assistant-actions/preview';
    const body = { idempotencyKey: 'one', requestId: 'request-one' };
    const headers = createSignedInternalRequestHeaders({
      secret,
      method,
      path: originalUrl,
      body,
    });
    const request = { method, originalUrl, body, headers };
    const guard = new InternalRequestGuard();

    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(() => guard.canActivate(contextFor(request))).toThrow('服务鉴权失败');
  });

  it('rejects a signature when the body was changed', () => {
    process.env['INTERNAL_SERVICE_SECRET'] = secret;
    const method = 'POST';
    const originalUrl = '/api/internal/assistant-actions/preview';
    const headers = createSignedInternalRequestHeaders({
      secret,
      method,
      path: originalUrl,
      body: { idempotencyKey: 'one' },
    });
    const guard = new InternalRequestGuard();

    expect(() =>
      guard.canActivate(
        contextFor({
          method,
          originalUrl,
          headers,
          body: { idempotencyKey: 'tampered' },
        }),
      ),
    ).toThrow('服务鉴权失败');
  });
});
