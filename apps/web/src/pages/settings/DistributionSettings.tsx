import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

export default function DistributionSettings() {
  const [rules, setRules] = useState<any[] | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const [r, u] = await Promise.all([api.get('/v1/distribution-rules'), api.get('/v1/users')]);
      setRules(r.items); setUsers(u.items);
    } catch (e: any) { setError(errMsg(e)); }
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="page-header">
        <div><h1>Lead Distribution</h1><p>Rules run top-to-bottom by priority; the first match wins</p></div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Rule</button>
      </div>
      {error && <Alert>{error}</Alert>}
      <DefaultAssignmentCard users={users} onError={setError} />
      <div className="card">
        {rules === null ? <Loading /> : rules.length === 0 ? <div className="card-body text-muted">No rules yet — new leads without an owner won't be auto-assigned.</div> : (
          <table>
            <thead><tr><th>Priority</th><th>Name</th><th>Strategy</th><th>Conditions</th><th>Status</th></tr></thead>
            <tbody>
              {rules.sort((a, b) => a.priority - b.priority).map(r => (
                <tr key={r.id}>
                  <td>{r.priority}</td><td>{r.name}</td><td><Badge kind="primary">{r.strategy}</Badge></td>
                  <td className="text-muted small">{r.conditions.length ? JSON.stringify(r.conditions) : 'Catch-all'}</td>
                  <td><Badge kind={r.is_active ? 'success' : 'muted'}>{r.is_active ? 'Active' : 'Paused'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showCreate && <CreateRuleModal users={users} onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

/** Fallback used once none of the distribution rules above match (or there are none) — this
 *  is what makes "System" (or a chosen person/per-field rule) the default owner of unassigned leads. */
function DefaultAssignmentCard({ users, onError }: { users: any[]; onError: (m: string) => void }) {
  const [settings, setSettings] = useState<any>(null);
  const [rows, setRows] = useState<{ field: string; op: string; value: string; userId: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    api.get('/v1/settings/tenant').then(s => {
      setSettings(s);
      setRows((s.defaultOwnerFieldRules || []).map((r: any) => ({
        field: r.conditions?.[0]?.field || '', op: r.conditions?.[0]?.op || 'eq', value: r.conditions?.[0]?.value || '', userId: r.userId,
      })));
    }).catch((e: any) => onError(errMsg(e)));
  }
  useEffect(() => { load(); }, []);

  async function save(patch: any) {
    setBusy(true); setSaved(false);
    try { const s = await api.patch('/v1/settings/tenant', patch); setSettings(s); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    catch (e: any) { onError(errMsg(e)); } finally { setBusy(false); }
  }

  function addRow() { setRows(r => [...r, { field: '', op: 'eq', value: '', userId: users[0]?.id || '' }]); }
  function updateRow(i: number, patch: any) { setRows(r => r.map((x, idx) => idx === i ? { ...x, ...patch } : x)); }
  function removeRow(i: number) { setRows(r => r.filter((_, idx) => idx !== i)); }
  function saveFieldRules() {
    save({ defaultOwnerFieldRules: rows.filter(r => r.field && r.userId).map(r => ({ conditions: [{ field: r.field, op: r.op, value: r.value }], userId: r.userId })) });
  }

  if (!settings) return null;
  return (
    <div className="card">
      <div className="card-header">Default Lead Assignment {saved && <Badge kind="success">Saved</Badge>}</div>
      <div className="card-body">
        <p className="small text-muted">Used once none of the distribution rules above match a new lead (or there are none).</p>
        <div className="form-row" style={{ maxWidth: 640 }}>
          <div className="form-group">
            <label>Assign to</label>
            <select value={settings.defaultOwnerMode} disabled={busy} onChange={e => save({ defaultOwnerMode: e.target.value })}>
              <option value="system">System user</option>
              <option value="user">A specific user</option>
              <option value="field">Different user per field value (below)</option>
            </select>
          </div>
          {settings.defaultOwnerMode === 'user' && (
            <div className="form-group">
              <label>User</label>
              <select value={settings.defaultOwnerUserId || ''} disabled={busy} onChange={e => save({ defaultOwnerUserId: e.target.value })}>
                <option value="">Select…</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.first_name} {u.last_name || ''}</option>)}
              </select>
            </div>
          )}
        </div>

        {settings.defaultOwnerMode === 'field' && (
          <div className="mt-16">
            <p className="small text-muted">e.g. City = Mumbai → assign to Riya; State = Punjab → assign to Aman. First matching row wins.</p>
            {rows.map((r, i) => (
              <div className="flex gap-8 mt-8" key={i}>
                <input placeholder="Field (e.g. fields.mx_city or sub_source)" value={r.field} onChange={e => updateRow(i, { field: e.target.value })} style={{ flex: 2 }} />
                <select value={r.op} onChange={e => updateRow(i, { op: e.target.value })} style={{ flex: 1 }}>
                  <option value="eq">is</option><option value="contains">contains</option>
                </select>
                <input placeholder="Value" value={r.value} onChange={e => updateRow(i, { value: e.target.value })} style={{ flex: 1 }} />
                <span className="text-muted small" style={{ alignSelf: 'center' }}>→</span>
                <select value={r.userId} onChange={e => updateRow(i, { userId: e.target.value })} style={{ flex: 1 }}>
                  {users.map(u => <option key={u.id} value={u.id}>{u.first_name} {u.last_name || ''}</option>)}
                </select>
                <button className="btn btn-sm" onClick={() => removeRow(i)}>✕</button>
              </div>
            ))}
            <div className="flex gap-8 mt-8">
              <button className="btn btn-sm" onClick={addRow}>+ Add rule</button>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={saveFieldRules}>Save Rules</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CreateRuleModal({ users, onClose, onDone }: { users: any[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [priority, setPriority] = useState(100);
  const [strategy, setStrategy] = useState('round_robin');
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function toggleUser(id: string) {
    setSelectedUsers(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  }

  async function submit() {
    setBusy(true); setError('');
    try {
      const strategyConfig = strategy === 'weighted_round_robin'
        ? { weights: Object.fromEntries(selectedUsers.map(u => [u, 1])) }
        : strategy === 'fixed_user' ? { userId: selectedUsers[0] } : { userIds: selectedUsers };
      await api.post('/v1/distribution-rules', { name, priority: Number(priority), strategy, strategyConfig, conditions: [] });
      onDone();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="New Distribution Rule" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Create Rule'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Rule name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
      <div className="form-row">
        <Field label="Priority" hint="Lower runs first"><input type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} /></Field>
        <Field label="Strategy">
          <select value={strategy} onChange={e => setStrategy(e.target.value)}>
            <option value="round_robin">Round robin</option>
            <option value="weighted_round_robin">Weighted round robin</option>
            <option value="least_open">Least open leads</option>
            <option value="fixed_user">Fixed user</option>
          </select>
        </Field>
      </div>
      <Field label="Eligible users">
        <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
          {users.map(u => (
            <label key={u.id} className="checkbox-row badge badge-muted" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={selectedUsers.includes(u.id)} onChange={() => toggleUser(u.id)} /> {u.first_name}
            </label>
          ))}
        </div>
      </Field>
    </Modal>
  );
}
