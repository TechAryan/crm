import React, { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { Alert, errMsg } from '../ui';

/**
 * Blocks the whole app until a user with mustChangePassword=true sets a new password.
 * Mirrors the server-side enforcement in auth.ts (enforcePasswordChange) — this is the
 * matching UI, not the security boundary; the API rejects everything except /v1/me/* either way.
 */
export default function ForcePasswordChange({ children }: { children: React.ReactNode }) {
  const { me, refresh } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!me?.mustChangePassword) return <>{children}</>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api.post('/v1/me/change-password', { currentPassword, newPassword });
      await refresh();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <div className="centered-page">
      <div className="auth-card">
        <h1>Set a new password</h1>
        <p className="sub">Your account was created with a temporary password — choose your own before continuing.</p>
        {error && <Alert>{error}</Alert>}
        <form onSubmit={submit}>
          <div className="form-group"><label>Temporary password</label>
            <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required autoFocus />
          </div>
          <div className="form-group"><label>New password</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={8} />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
            {busy ? 'Saving…' : 'Set password & continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
