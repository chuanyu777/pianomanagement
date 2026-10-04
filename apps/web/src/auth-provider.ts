import type { AuthProvider } from '@refinedev/core';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
export const TOKEN_KEY = 'piano.access_token';
export const USER_KEY = 'piano.user';

export type CurrentUser = {
  id: string;
  username: string;
  displayName: string;
  role: 'OWNER' | 'TEACHER';
};

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getCurrentUser(): CurrentUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CurrentUser;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json } as { ok: boolean; status: number; json: any };
}

/**
 * 鉴权走后端的 JWT：登录拿 accessToken 存 localStorage，之后每个请求带 Bearer。
 * 401 一律登出 —— token 过期或被停用都要回到登录页，不要留在一个「看着能用其实全 401」的界面。
 */
export const authProvider: AuthProvider = {
  login: async ({ username, password }) => {
    const { ok, json } = await post('/auth/login', { username, password });
    if (!ok) {
      return {
        success: false,
        error: { message: json?.message ?? '登录失败', name: '登录失败' },
      };
    }
    localStorage.setItem(TOKEN_KEY, json.accessToken);
    localStorage.setItem(USER_KEY, JSON.stringify(json.user));
    return { success: true, redirectTo: '/' };
  },

  logout: async () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    return { success: true, redirectTo: '/login' };
  },

  check: async () => {
    const token = getToken();
    if (!token) return { authenticated: false, logout: true, redirectTo: '/login' };
    return { authenticated: true };
  },

  getPermissions: async () => getCurrentUser()?.role ?? null,

  getIdentity: async () => getCurrentUser(),

  onError: async (error) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 401) return { logout: true, redirectTo: '/login' };
    return {};
  },

  register: async () => ({ success: false }),
  forgotPassword: async () => ({ success: false }),
  updatePassword: async () => ({ success: false }),
};
