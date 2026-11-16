import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, publicApi, getToken, setToken } from './api';

export interface Me {
  userId: string; tenantId: string; tenantCode: string;
  permissions: any; uiPolicy: any; recordScope: string;
  mustChangePassword?: boolean;
}

type LoginResult = { requires2fa: true } | { requires2fa: false };

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (tenantCode: string, email: string, password: string) => Promise<LoginResult>;
  completeTwoFactor: (code: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingToken, setPendingToken] = useState<string | null>(null);

  async function refresh() {
    if (!getToken()) { setMe(null); setLoading(false); return; }
    try {
      const data = await api.get('/v1/me');
      setMe(data);
    } catch {
      setToken(null); setMe(null);
    } finally { setLoading(false); }
  }

  useEffect(() => { refresh(); }, []);

  async function login(tenantCode: string, email: string, password: string): Promise<LoginResult> {
    const resp = await publicApi.post('/auth/login', { tenantCode, email, password });
    if (resp.requires2fa) { setPendingToken(resp.pendingToken); return { requires2fa: true }; }
    setToken(resp.token);
    await refresh();
    return { requires2fa: false };
  }

  async function completeTwoFactor(code: string) {
    if (!pendingToken) throw new Error('No login in progress');
    const resp = await publicApi.post('/auth/login/2fa', { pendingToken, code });
    setPendingToken(null);
    setToken(resp.token);
    await refresh();
  }

  function logout() { setToken(null); setMe(null); }

  return <Ctx.Provider value={{ me, loading, login, completeTwoFactor, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Convenience permission helpers matching the backend permission shape. */
export function can(me: Me | null, entity: string, action: string): boolean {
  if (!me) return false;
  const p = me.permissions?.[entity];
  if (!p) return false;
  const v = p[action];
  if (action === 'create') return !!v;
  return v && v !== false;
}
export function hasSetting(me: Me | null, key: string): boolean {
  return !!me?.permissions?.settings?.[key];
}
export function isTabHidden(me: Me | null, tab: string): boolean {
  return !!me?.uiPolicy?.hiddenTabs?.includes(tab);
}
