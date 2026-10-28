const ACCESS_TOKEN_KEY = 'pianomanager.accessToken';
const REFRESH_TOKEN_KEY = 'pianomanager.refreshToken';

/**
 * `expired` means the server explicitly rejected the refresh token (session really over).
 * `unavailable` means we could not reach the server, so the session must be kept.
 */
export type SessionRefreshOutcome = 'refreshed' | 'expired' | 'unavailable';

export class SessionExpiredError extends Error {
  constructor(message = '登录状态已失效，请重新登录后再试。') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export class ServiceUnavailableError extends Error {
  constructor(message = '服务暂时不可用，请稍后重试。') {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

let inflightRefresh: Promise<SessionRefreshOutcome> | null = null;

export function getAccessToken(): string | null {
  try {
    return window.localStorage.getItem(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeSession(accessToken: string, refreshToken?: string | null): void {
  try {
    window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    if (typeof refreshToken === 'string' && refreshToken) {
      window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    }
  } catch {
    // A full or unavailable localStorage must not crash the caller.
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Ignore storage failures; in-memory state is cleared by the caller.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Single-flight refresh: concurrent 401s share one request so a rotating
 * refresh token is never spent twice.
 */
export function refreshSession(fetchImpl?: typeof fetch): Promise<SessionRefreshOutcome> {
  if (inflightRefresh) return inflightRefresh;
  const run = (async (): Promise<SessionRefreshOutcome> => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return 'expired';
    let response: Response;
    try {
      response = await (fetchImpl ?? fetch)('/api/auth/refresh', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      return 'unavailable';
    }
    if (response.status === 401 || response.status === 403) return 'expired';
    if (!response.ok) return 'unavailable';
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      return 'unavailable';
    }
    if (!isRecord(payload) || typeof payload.accessToken !== 'string') return 'unavailable';
    storeSession(payload.accessToken, typeof payload.refreshToken === 'string' ? payload.refreshToken : null);
    return 'refreshed';
  })();
  inflightRefresh = run.finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

/** Revokes the refresh token server-side. Best effort: local state is cleared regardless. */
export function revokeSession(fetchImpl?: typeof fetch): void {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return;
  void (fetchImpl ?? fetch)('/api/auth/logout', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  }).catch(() => undefined);
}
