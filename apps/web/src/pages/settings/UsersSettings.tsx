import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';
import { DynamicFields, type FieldDef } from '../../components/DynamicFields';

export default function UsersSettings() {
  const [users, setUsers] = useState<any[] | null>(null);
  const [roles, setRoles] = useState<any[]>([]);
  const [userFieldDefs, setUserFieldDefs] = useState<FieldDef[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [credentials, setCredentials] = useState<{ email: string; tempPassword: string; resetUrl: string } | null>(null);
  const [error, setError] = useState('');

  async function load() {
    try {
      const [u, r, f] = await Promise.all([api.get('/v1/users'), api.get('/v1/roles'), api.get('/v1/fields/user').catch(() => ({ items: [] }))]);
      setUsers(u.items); setRoles(r.items); setUserFieldDefs(f.items);
    } catch (e: any) { setError(errMsg(e)); }
  }
  useEffect(() => { load(); }, []);
  const roleName = (id: string) => roles.find(r => r.id === id)?.name || '—';

  async function toggle(u: any, key: 'isActive' | 'isCheckedIn', val: boolean) {
    try { await api.patch(`/v1/users/${u.id}`, { [key]: val }); load(); } catch (e: any) { setError(errMsg(e)); }
  }

  async function setManager(u: any, managerId: string) {
    try { await api.patch(`/v1/users/${u.id}`, { managerId: managerId || null }); load(); } catch (e: any) { setError(errMsg(e)); }
  }

  async function resendLink(u: any) {
    try {
      const d = await api.post(`/v1/users/${u.id}/reset-link`);
      setCredentials({ email: u.email, tempPassword: '', resetUrl: d.resetUrl });
    } catch (e: any) { setError(errMsg(e)); }
  }

  return (
    <div>
      <div className="page-header">
        <div><h1>Users</h1><p>Create and manage users; check-in status feeds lead distribution</p></div>
        <div className="flex gap-8">
          <button className="btn" onClick={() => setShowBulk(true)}>Bulk Create (CSV)</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Create User</button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        {users === null ? <Loading /> : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Manager</th><th>Status</th><th>Availability</th><th></th></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ cursor: 'default' }}>
                  <td>{u.first_name} {u.last_name} {u.is_system && <Badge kind="muted">System</Badge>}</td><td>{u.email}</td><td>{roleName(u.role_id)}</td>
                  <td>
                    {u.is_system ? <span className="text-muted small">—</span> : (
                      <select value={u.manager_id || ''} onChange={e => setManager(u, e.target.value)} style={{ maxWidth: 160 }}>
                        <option value="">No manager</option>
                        {users.filter(m => m.id !== u.id).map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name || ''}</option>)}
                      </select>
                    )}
                  </td>
                  <td><Badge kind={u.is_active ? 'success' : 'muted'}>{u.is_active ? 'Active' : 'Inactive'}</Badge></td>
                  <td><Badge kind={u.is_checked_in ? 'primary' : 'muted'}>{u.is_checked_in ? 'Checked in' : 'Checked out'}</Badge></td>
                  <td className="flex gap-8">
                    <button className="btn btn-sm" onClick={() => toggle(u, 'isCheckedIn', !u.is_checked_in)}>{u.is_checked_in ? 'Check out' : 'Check in'}</button>
                    <button className="btn btn-sm" disabled={u.is_system} onClick={() => toggle(u, 'isActive', !u.is_active)}>{u.is_active ? 'Deactivate' : 'Activate'}</button>
                    <button className="btn btn-sm" onClick={() => resendLink(u)}>Set-password link</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showCreate && (
        <CreateUserModal roles={roles} users={users || []} fieldDefs={userFieldDefs} onClose={() => setShowCreate(false)}
          onDone={(creds) => { setShowCreate(false); load(); if (creds) setCredentials(creds); }} />
      )}
      {showBulk && (
        <BulkCreateModal roles={roles} onClose={() => setShowBulk(false)} onDone={() => { setShowBulk(false); load(); }} />
      )}
      {credentials && <CredentialsModal creds={credentials} onClose={() => setCredentials(null)} />}
    </div>
  );
}

/** Shown once after creating/re-inviting a user — no email is sent, so the admin copies and
 *  shares this manually (Slack, WhatsApp, in person, whatever's convenient). */
function CredentialsModal({ creds, onClose }: { creds: { email: string; tempPassword: string; resetUrl: string }; onClose: () => void }) {
  return (
    <Modal title="Share these credentials" onClose={onClose} width={520} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <Alert kind="success">No email/SMS is connected yet — copy this and share it with {creds.email} yourself.</Alert>
      {creds.tempPassword && (
        <div className="form-group">
          <label>Temporary password</label>
          <input readOnly value={creds.tempPassword} onFocus={e => e.target.select()} className="mono" />
        </div>
      )}
      <div className="form-group">
        <label>Or send this one-time set-password link (valid 24h)</label>
        <input readOnly value={creds.resetUrl} onFocus={e => e.target.select()} className="mono" />
      </div>
    </Modal>
  );
}

function CreateUserModal({ roles, users, fieldDefs, onClose, onDone }: {
  roles: any[]; users: any[]; fieldDefs: FieldDef[]; onClose: () => void;
  onDone: (creds: { email: string; tempPassword: string; resetUrl: string } | null) => void;
}) {
  const [form, setForm] = useState<any>({ email: '', firstName: '', lastName: '', phone: '', password: '', roleId: roles[0]?.id || '', managerId: '' });
  const [fields, setFields] = useState<Record<string, any>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  async function submit() {
    setBusy(true); setError('');
    try {
      const body = { ...form, fields, password: form.password || undefined, managerId: form.managerId || undefined };
      const created = await api.post('/v1/users', body);
      onDone(created.generatedCredentials ? { email: form.email, tempPassword: created.generatedCredentials.tempPassword, resetUrl: created.generatedCredentials.resetUrl } : null);
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Create User" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Create User'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <div className="form-row">
        <Field label="First name"><input value={form.firstName} onChange={e => set('firstName', e.target.value)} /></Field>
        <Field label="Last name"><input value={form.lastName} onChange={e => set('lastName', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Email"><input type="email" value={form.email} onChange={e => set('email', e.target.value)} /></Field>
        <Field label="Phone"><input value={form.phone} onChange={e => set('phone', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Temporary password" hint="Leave blank to auto-generate one + a set-password link">
          <input type="password" value={form.password} onChange={e => set('password', e.target.value)} />
        </Field>
        <Field label="Role">
          <select value={form.roleId} onChange={e => set('roleId', e.target.value)}>
            {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Manager" hint="Used for hierarchy visibility and manager dashboard views">
        <select value={form.managerId} onChange={e => set('managerId', e.target.value)}>
          <option value="">No manager</option>
          {users.filter(u => !u.is_system).map(u => <option key={u.id} value={u.id}>{u.first_name} {u.last_name || ''}</option>)}
        </select>
      </Field>
      <DynamicFields defs={fieldDefs} values={fields} onChange={(k, v) => setFields(f => ({ ...f, [k]: v }))} />
    </Modal>
  );
}

function BulkCreateModal({ roles, onClose, onDone }: { roles: any[]; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('email,firstName,lastName,role\n');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => setCsv(String(r.result || ''));
    r.readAsText(f);
  }

  function parseRows(): any[] {
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    return lines.slice(1).map(line => {
      const cells = line.split(',').map(c => c.trim());
      const row: any = {};
      headers.forEach((h, i) => { row[h] = cells[i]; });
      const role = roles.find(r => r.name.toLowerCase() === (row.role || '').toLowerCase());
      return { email: row.email, firstName: row.firstname, lastName: row.lastname || undefined, roleId: role?.id };
    }).filter(r => r.email);
  }

  async function submit() {
    setBusy(true); setError(''); setResults(null);
    try {
      const rows = parseRows();
      const missingRole = rows.some(r => !r.roleId);
      if (missingRole) throw new Error('One or more rows have a "role" column that doesn\'t match any existing role name.');
      if (!rows.length) throw new Error('No valid rows found — need at least email + firstName + role columns.');
      const d = await api.post('/v1/users/bulk', { users: rows });
      setResults(d.results);
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Bulk Create Users" onClose={onClose} width={680} footer={results ? <button className="btn btn-primary" onClick={onDone}>Done</button> : <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create Users'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      {!results ? (
        <div>
          <p className="small text-muted">CSV columns: <span className="mono">email, firstName, lastName, role</span> (role must match an existing role name exactly, e.g. "Sales User").</p>
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
          <textarea rows={8} value={csv} onChange={e => setCsv(e.target.value)} style={{ width: '100%', marginTop: 8, fontFamily: 'monospace' }} />
        </div>
      ) : (
        <div>
          <p className="small">{results.filter(r => r.status === 'created').length} created, {results.filter(r => r.status === 'error').length} failed.</p>
          <table>
            <thead><tr><th>Email</th><th>Status</th><th>Temp password / link</th></tr></thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td className="small">{r.email}</td>
                  <td><Badge kind={r.status === 'created' ? 'success' : 'danger'}>{r.status === 'created' ? 'Created' : r.error}</Badge></td>
                  <td className="small mono">{r.user?.generatedCredentials ? `${r.user.generatedCredentials.tempPassword}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small text-muted mt-8">Copy each temp password (or use "Set-password link" from the users list) and share it with the person yourself — no email is sent yet.</p>
        </div>
      )}
    </Modal>
  );
}
