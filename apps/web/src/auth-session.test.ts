import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  refreshSession,
  storeSession,
} from './auth-session.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('refreshSession', () => {
  it('stores the rotated access and refresh tokens on success', async () => {
    storeSession('old-access', 'old-refresh');
    const fetchImpl = vi.fn(async () => jsonResponse({ accessToken: 'new-access', refreshToken: 'new-refresh' }));

    await expect(refreshSession(fetchImpl as never)).resolves.toBe('refreshed');

    expect(getAccessToken()).toBe('new-access');
    expect(getRefreshToken()).toBe('new-refresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports expired when the server rejects the refresh token, keeping the decision to the caller', async () => {
    storeSession('old-access', 'old-refresh');
    const fetchImpl = vi.fn(async () => jsonResponse({ message: '登录状态无效或已过期' }, 401));

    await expect(refreshSession(fetchImpl as never)).resolves.toBe('expired');

    // refreshSession never clears storage itself; only the caller ends the session.
    expect(getAccessToken()).toBe('old-access');
    expect(getRefreshToken()).toBe('old-refresh');
  });

  it('reports unavailable on a network failure and keeps the session intact', async () => {
    storeSession('old-access', 'old-refresh');
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(refreshSession(fetchImpl as never)).resolves.toBe('unavailable');

    expect(getAccessToken()).toBe('old-access');
    expect(getRefreshToken()).toBe('old-refresh');
  });

  it('reports unavailable when the service returns 5xx and keeps the session intact', async () => {
    storeSession('old-access', 'old-refresh');
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Service Unavailable' }, 503));

    await expect(refreshSession(fetchImpl as never)).resolves.toBe('unavailable');

    expect(getAccessToken()).toBe('old-access');
    expect(getRefreshToken()).toBe('old-refresh');
  });

  it('reports expired when no refresh token is stored', async () => {
    const fetchImpl = vi.fn();
    await expect(refreshSession(fetchImpl as never)).resolves.toBe('expired');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('shares a single in-flight request across concurrent callers so a rotating token is spent once', async () => {
    storeSession('old-access', 'old-refresh');
    let release: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      release = resolve;
    }));

    const first = refreshSession(fetchImpl as never);
    const second = refreshSession(fetchImpl as never);
    release?.(jsonResponse({ accessToken: 'new-access', refreshToken: 'new-refresh' }));

    await expect(Promise.all([first, second])).resolves.toEqual(['refreshed', 'refreshed']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getRefreshToken()).toBe('new-refresh');
  });

  it('allows a new refresh attempt after the previous one settled', async () => {
    storeSession('old-access', 'old-refresh');
    const fetchImpl = vi.fn(async () => jsonResponse({ accessToken: 'a1', refreshToken: 'r1' }));

    await expect(refreshSession(fetchImpl as never)).resolves.toBe('refreshed');
    await expect(refreshSession(fetchImpl as never)).resolves.toBe('refreshed');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getRefreshToken()).toBe('r1');
  });
});

describe('session storage helpers', () => {
  it('clears both tokens on clearSession', () => {
    storeSession('access', 'refresh');
    clearSession();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('keeps an existing refresh token when storeSession is called without one', () => {
    storeSession('access-1', 'refresh-1');
    storeSession('access-2');
    expect(getAccessToken()).toBe('access-2');
    expect(getRefreshToken()).toBe('refresh-1');
  });
});
