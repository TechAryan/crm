import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { publicApi } from '../api';
import { Alert, errMsg } from '../ui';

/**
 * Public page for "set your password" links.
 *
 *   tenant: /reset-password?token=…        -> POST /auth/reset-password        -> /login
 *   host:   /host/reset-password?token=…   -> POST /host/auth/reset-password   -> /host/login
 *
 * The host variant is not optional decoration: the host forgot-password endpoint emails a link to
 * `${APP_URL}/host/reset-password?token=…`, and that route did not exist — the catch-all redirected
 * it to the tenant login, so an admin following their own reset email landed on the wrong form with
 * the token silently dropped. Recovering the admin account then required the break-glass CLI.
 */
export default function ResetPasswordPage({ variant = 'tenant' }: { variant?: 'tenant' | 'host' }) {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const nav = useNavigate();
  const isHost = variant === 'host';
  const endpoint = isHost ? '/host/auth/reset-password' : '/auth/reset-password';
  const loginPath = isHost ? '/host/login' : '/login';
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!token) { setError('This link is missing its token — ask your admin to send a new one.'); return; }
    if (newPassword.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (newPassword !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await publicApi.post(endpoint, { token, newPassword });
      setDone(true);
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="centered-page">
        <div className="auth-card">
          <h1>Password set</h1>
          <p className="sub">You can now sign in with your new password.</p>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => nav(loginPath)}>Go to sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="centered-page">
      <div className="auth-card">
        <h1>Set your password</h1>
        <p className="sub">Choose a password to finish setting up your account</p>
        {error && <Alert>{error}</Alert>}
        <form onSubmit={submit}>
          <div className="form-group"><label>New password</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={8} autoFocus />
          </div>
          <div className="form-group"><label>Confirm password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </form>
      </div>
    </div>
  );
}
