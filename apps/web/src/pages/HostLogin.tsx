import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHostAuth } from '../HostAuthContext';
import { publicApi } from '../api';
import { Alert, errMsg } from '../ui';

export default function HostLogin() {
  const { login } = useHostAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('owner@nexcrm.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try { await login(email, password); nav('/host/tenants'); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <div className="centered-page">
      <div className="auth-card">
        <h1>NexCRM Admin Console</h1>
        <p className="sub">For the platform team and reseller partners</p>
        {error && <Alert>{error}</Alert>}
        <form onSubmit={submit}>
          <div className="form-group"><label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
          </div>
          <div className="form-group"><label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {/* Host admins have no admin above them to reset their password, so this is their only
            self-serve route back in short of the break-glass CLI. Requires SYSTEM_EMAIL_* to be
            configured; without it the request succeeds silently and no mail is sent. */}
        <p className="small mt-16">
          <a onClick={() => setForgot(true)} style={{ color: 'var(--primary)', fontWeight: 600, cursor: 'pointer' }}>
            Forgot your password?
          </a>
        </p>
        {forgot && <HostForgot email={email} onClose={() => setForgot(false)} />}
        <p className="small text-muted mt-16">Tenant user? <a href="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Go to CRM login</a></p>
      </div>
    </div>
  );
}

function HostForgot({ email, onClose }: { email: string; onClose: () => void }) {
  const [em, setEm] = useState(email);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r: any = await publicApi.post('/host/auth/forgot-password', { email: em });
      setMsg(r?.message || 'If an account exists for that email, a reset link has been sent.');
    } catch { setMsg('If an account exists for that email, a reset link has been sent.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ marginTop: 12, padding: 14, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong className="small">Reset admin password</strong>
        <a onClick={onClose} className="small" style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>Close</a>
      </div>
      {msg ? <p className="small" style={{ margin: 0 }}>{msg}</p> : (
        <form onSubmit={submit}>
          <div className="form-group"><label>Email</label>
            <input type="email" value={em} onChange={e => setEm(e.target.value)} required />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
    </div>
  );
}
