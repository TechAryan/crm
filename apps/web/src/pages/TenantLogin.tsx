import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { publicApi } from '../api';
import { Alert, errMsg } from '../ui';

export default function TenantLogin() {
  const { login, completeTwoFactor } = useAuth();
  const nav = useNavigate();
  const [tenantCode, setTenantCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const result = await login(tenantCode, email, password);
      if (result.requires2fa) setNeeds2fa(true);
      else nav('/leads');
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  async function submitTwoFactor(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try { await completeTwoFactor(code); nav('/leads'); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  if (needs2fa) {
    return (
      <div className="centered-page">
        <div className="auth-card">
          <h1>Two-factor verification</h1>
          <p className="sub">Enter the 6-digit code from your authenticator app, or a backup code</p>
          {error && <Alert>{error}</Alert>}
          <form onSubmit={submitTwoFactor}>
            <div className="form-group"><label>Code</label>
              <input value={code} onChange={e => setCode(e.target.value)} autoFocus required placeholder="123456" />
            </div>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </form>
          <p className="small text-muted mt-16"><a href="#" onClick={e => { e.preventDefault(); setNeeds2fa(false); setCode(''); }} style={{ color: 'var(--primary)', fontWeight: 600 }}>Back to sign in</a></p>
        </div>
      </div>
    );
  }

  return (
    <div className="centered-page">
      <div className="auth-card">
        <h1>Sign in to NexCRM</h1>
        <p className="sub">Enter your tenant ID and credentials</p>
        {error && <Alert>{error}</Alert>}
        <form onSubmit={submit}>
          <div className="form-group"><label>Tenant ID / subdomain</label>
            <input value={tenantCode} onChange={e => setTenantCode(e.target.value)} placeholder="e.g. test or t-8FK2Q" required />
          </div>
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
        {/* The /auth/forgot-password endpoint existed from the start but nothing in the UI reached
            it, so a locked-out user had no route back in except phoning their admin. */}
        <p className="small mt-16">
          <a onClick={() => setForgot(true)} style={{ color: 'var(--primary)', fontWeight: 600, cursor: 'pointer' }}>
            Forgot your password?
          </a>
        </p>
        {forgot && <ForgotPassword tenantCode={tenantCode} email={email} onClose={() => setForgot(false)} />}
        <p className="small text-muted mt-16">Host / partner admin? <a href="/host/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Go to admin console</a></p>
      </div>
    </div>
  );
}

/**
 * Self-serve password reset request.
 *
 * The response is deliberately identical whether or not the account exists — telling an anonymous
 * caller "no such user" turns this into an account-enumeration oracle. When the tenant uses the
 * default internal reset mode the API returns a hint telling the user to contact their admin or
 * manager, which is shown as-is.
 */
function ForgotPassword({ tenantCode, email, onClose }: { tenantCode: string; email: string; onClose: () => void }) {
  const [tc, setTc] = useState(tenantCode);
  const [em, setEm] = useState(email);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setMsg(''); setBusy(true);
    try {
      const r: any = await publicApi.post('/auth/forgot-password', { tenantCode: tc, email: em });
      setMsg([r?.message, r?.hint].filter(Boolean).join(' '));
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginTop: 12, padding: 14, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong className="small">Reset your password</strong>
        <a onClick={onClose} className="small" style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>Close</a>
      </div>
      {error && <Alert>{error}</Alert>}
      {msg
        ? <p className="small" style={{ margin: 0 }}>{msg}</p>
        : (
          <form onSubmit={submit}>
            <div className="form-group"><label>Tenant ID / subdomain</label>
              <input value={tc} onChange={e => setTc(e.target.value)} required />
            </div>
            <div className="form-group"><label>Email</label>
              <input type="email" value={em} onChange={e => setEm(e.target.value)} required />
            </div>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
              {busy ? 'Sending…' : 'Send reset instructions'}
            </button>
          </form>
        )}
    </div>
  );
}
