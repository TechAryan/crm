import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

export default function ProfileSettings() {
  const [profile, setProfile] = useState<any>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showEnroll, setShowEnroll] = useState(false);
  const [showDisable, setShowDisable] = useState(false);

  function load() { api.get('/v1/me/profile').then(setProfile).catch(() => {}); }
  useEffect(() => { load(); }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      await api.post('/v1/me/change-password', { currentPassword, newPassword });
      setMsg({ kind: 'success', text: 'Password changed.' });
      setCurrentPassword(''); setNewPassword('');
    } catch (e: any) { setMsg({ kind: 'danger', text: errMsg(e) }); } finally { setBusy(false); }
  }

  if (!profile) return <Loading />;
  return (
    <div>
      <div className="page-header"><div><h1>My Profile</h1><p>Manage your personal profile</p></div></div>
      <div className="card">
        <div className="card-header">Personal Details</div>
        <div className="card-body">
          <table>
            <tbody>
              <tr><td className="text-muted" style={{ width: 200 }}>Name</td><td>{profile.first_name} {profile.last_name}</td></tr>
              <tr><td className="text-muted">Email</td><td>{profile.email}</td></tr>
              <tr><td className="text-muted">Phone</td><td>{profile.phone || '—'}</td></tr>
              <tr><td className="text-muted">Role</td><td>{profile.role_name || '—'}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="card-header">Change Password</div>
        <div className="card-body" style={{ maxWidth: 420 }}>
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          <form onSubmit={changePassword}>
            <Field label="Current password"><input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required /></Field>
            <Field label="New password" hint="Minimum 8 characters"><input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required /></Field>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Change Password'}</button>
          </form>
        </div>
      </div>
      <div className="card">
        <div className="card-header">Two-Factor Authentication</div>
        <div className="card-body">
          <p className="small text-muted">Use an authenticator app (Google Authenticator, Authy, 1Password, …) for a second sign-in step. No SMS or email needed.</p>
          <p><Badge kind={profile.totp_enabled ? 'success' : 'muted'}>{profile.totp_enabled ? 'Enabled' : 'Disabled'}</Badge></p>
          {profile.totp_enabled
            ? <button className="btn" onClick={() => setShowDisable(true)}>Disable 2FA</button>
            : <button className="btn btn-primary" onClick={() => setShowEnroll(true)}>Enable 2FA</button>}
        </div>
      </div>
      {showEnroll && <Enroll2FAModal onClose={() => setShowEnroll(false)} onDone={() => { setShowEnroll(false); load(); }} />}
      {showDisable && <Disable2FAModal onClose={() => setShowDisable(false)} onDone={() => { setShowDisable(false); load(); }} />}
    </div>
  );
}

function Enroll2FAModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<'loading' | 'scan' | 'backup'>('loading');
  const [secret, setSecret] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.post('/v1/me/2fa/setup').then(async d => {
      setSecret(d.secret);
      setQrDataUrl(await QRCode.toDataURL(d.otpauthUrl));
      setStep('scan');
    }).catch(e => setError(errMsg(e)));
  }, []);

  async function verify() {
    setBusy(true); setError('');
    try {
      const d = await api.post('/v1/me/2fa/verify', { code });
      setBackupCodes(d.backupCodes);
      setStep('backup');
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Enable Two-Factor Authentication" onClose={onClose} width={480} footer={
      step === 'scan'
        ? <><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || code.length !== 6} onClick={verify}>{busy ? 'Verifying…' : 'Verify & Enable'}</button></>
        : step === 'backup' ? <button className="btn btn-primary" onClick={onDone}>Done</button> : null
    }>
      {error && <Alert>{error}</Alert>}
      {step === 'loading' && <Loading />}
      {step === 'scan' && (
        <div>
          <p className="small text-muted">Scan this QR code with your authenticator app, then enter the 6-digit code it shows.</p>
          {qrDataUrl && <img src={qrDataUrl} alt="2FA QR code" style={{ display: 'block', margin: '12px auto' }} />}
          <p className="small text-muted" style={{ textAlign: 'center' }}>Can't scan? Enter this key manually: <span className="mono">{secret}</span></p>
          <Field label="6-digit code"><input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" autoFocus /></Field>
        </div>
      )}
      {step === 'backup' && (
        <div>
          <Alert kind="success">2FA is now enabled.</Alert>
          <p className="small">Save these one-time backup codes somewhere safe — each can be used once if you lose access to your authenticator app:</p>
          <pre className="mono small" style={{ background: 'var(--bg-muted,#f6f8fa)', padding: 12, borderRadius: 6 }}>{backupCodes.join('\n')}</pre>
        </div>
      )}
    </Modal>
  );
}

function Disable2FAModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError('');
    try { await api.post('/v1/me/2fa/disable', { currentPassword }); onDone(); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Disable Two-Factor Authentication" onClose={onClose} width={420} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Disabling…' : 'Disable 2FA'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Confirm your password"><input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}
