import React, { createContext, useContext, useEffect, useState } from 'react';
import { hostApi, getHostToken, setHostToken, publicApi } from './api';

interface HostUser { id: string; name: string; email: string; role: string; }
interface HostAuthState {
  hostUser: HostUser | null; loading: boolean;
  login: (email: string, password: string) => Promise<void>; logout: () => void;
}
const Ctx = createContext<HostAuthState | null>(null);

export function HostAuthProvider({ children }: { children: React.ReactNode }) {
  const [hostUser, setHostUser] = useState<HostUser | null>(() => {
    const raw = localStorage.getItem('nx_host_user');
    return raw ? JSON.parse(raw) : null;
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (getHostToken() && !hostUser) {
      // token exists but no cached user info; verify by hitting a lightweight endpoint
      hostApi.get('/host/api/tenants').catch(() => { setHostToken(null); setHostUser(null); });
    }
  }, []);

  async function login(email: string, password: string) {
    const data = await publicApi.post('/host/auth/login', { email, password }) as any;
    setHostToken(data.token);
    setHostUser(data.user);
    localStorage.setItem('nx_host_user', JSON.stringify(data.user));
  }
  function logout() { setHostToken(null); setHostUser(null); localStorage.removeItem('nx_host_user'); }

  return <Ctx.Provider value={{ hostUser, loading, login, logout }}>{children}</Ctx.Provider>;
}

export function useHostAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useHostAuth must be used within HostAuthProvider');
  return ctx;
}
