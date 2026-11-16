const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000';

export function getToken() { return localStorage.getItem('nx_token'); }
export function setToken(t: string | null) { t ? localStorage.setItem('nx_token', t) : localStorage.removeItem('nx_token'); }
export function getHostToken() { return localStorage.getItem('nx_host_token'); }
export function setHostToken(t: string | null) { t ? localStorage.setItem('nx_host_token', t) : localStorage.removeItem('nx_host_token'); }

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string) { super(message); }
}

async function request(path: string, opts: RequestInit = {}, authKind: 'tenant' | 'host' | 'none' = 'tenant') {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers as any) };
  if (authKind === 'tenant') {
    const t = getToken();
    if (t) headers.authorization = `Bearer ${t}`;
  } else if (authKind === 'host') {
    const t = getHostToken();
    if (t) headers.authorization = `Bearer ${t}`;
  }
  const resp = await fetch(API_URL + path, { ...opts, headers });
  if (resp.status === 204) return null;
  let json: any = null;
  try { json = await resp.json(); } catch { /* empty */ }
  if (!resp.ok) {
    const e = json?.error || { code: 'UNKNOWN', message: `Request failed (${resp.status})` };
    throw new ApiClientError(resp.status, e.code, e.message, e.field);
  }
  return json;
}

export const api = {
  get: (path: string) => request(path, { method: 'GET' }),
  post: (path: string, body?: any) => request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: (path: string, body?: any) => request(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: (path: string) => request(path, { method: 'DELETE' }),
  // Streams a file endpoint to a browser download (used for CSV export).
  download: async (path: string, fallbackName = 'download') => {
    const t = getToken();
    const resp = await fetch(API_URL + path, { headers: t ? { authorization: `Bearer ${t}` } : {} });
    if (!resp.ok) {
      let msg = `Request failed (${resp.status})`;
      try { const j = await resp.json(); msg = j?.error?.message || msg; } catch { /* not json */ }
      throw new ApiClientError(resp.status, 'DOWNLOAD_FAILED', msg);
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('content-disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const name = m?.[1] || fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
  },
};

export const hostApi = {
  get: (path: string) => request(path, { method: 'GET' }, 'host'),
  post: (path: string, body?: any) => request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }, 'host'),
  patch: (path: string, body?: any) => request(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }, 'host'),
  del: (path: string) => request(path, { method: 'DELETE' }, 'host'),
};

export const publicApi = {
  post: (path: string, body?: any) => request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }, 'none'),
};
