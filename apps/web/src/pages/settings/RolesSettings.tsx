import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

const HIDEABLE_TABS = ['Settings', 'Reports', 'Opportunities', 'Tasks'];

export default function RolesSettings() {
  const [roles, setRoles] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [error, setError] = useState('');

  async function load() { try { setRoles((await api.get('/v1/roles')).items); } catch (e: any) { setError(errMsg(e)); } }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="page-header">
        <div><h1>Roles</h1><p>Roles decide record visibility and which parts of the UI each user type sees</p></div>
        <button className="btn btn-primary" onClick={() => setEditing({ name: '', recordScope: 'own', hiddenTabs: [] })}>+ Create Role</button>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        {roles === null ? <Loading /> : (
          <table>
            <thead><tr><th>Name</th><th>Record Scope</th><th>Hidden UI Tabs</th><th></th></tr></thead>
            <tbody>
              {roles.map(r => (
                <tr key={r.id} style={{ cursor: 'default' }}>
                  <td>{r.name} {r.is_system && <Badge kind="muted">system</Badge>}</td>
                  <td><Badge kind="primary">{r.record_scope}</Badge></td>
                  <td className="text-muted">{(r.ui_policy?.hiddenTabs || []).join(', ') || '—'}</td>
                  <td><button className="btn btn-sm" onClick={() => setEditing({ id: r.id, name: r.name, recordScope: r.record_scope, hiddenTabs: r.ui_policy?.hiddenTabs || [] })}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <RoleModal role={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function RoleModal({ role, onClose, onDone }: { role: any; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(role.name);
  const [recordScope, setRecordScope] = useState(role.recordScope);
  const [hiddenTabs, setHiddenTabs] = useState<string[]>(role.hiddenTabs);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function toggleTab(t: string) { setHiddenTabs(cur => cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t]); }

  async function save() {
    setBusy(true); setError('');
    try {
      const body = { name, recordScope, uiPolicy: { hiddenTabs } };
      if (role.id) await api.patch(`/v1/roles/${role.id}`, body);
      else await api.post('/v1/roles', body);
      onDone();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={role.id ? `Edit: ${role.name}` : 'Create Role'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name} onClick={save}>{busy ? 'Saving…' : 'Save Role'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Role name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Record visibility scope">
        <select value={recordScope} onChange={e => setRecordScope(e.target.value)}>
          <option value="own">Own records only</option>
          <option value="team">Team records</option>
          <option value="all">All records</option>
        </select>
      </Field>
      <Field label="Hide UI tabs for this role" hint="Hidden in the UI and independently enforced by the API's permission checks">
        <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
          {HIDEABLE_TABS.map(t => (
            <label key={t} className="checkbox-row badge badge-muted" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={hiddenTabs.includes(t)} onChange={() => toggleTab(t)} /> {t}
            </label>
          ))}
        </div>
      </Field>
      <p className="hint">Action rights (create/edit/delete per entity) come from Permission Sets — attach them on the Permission Sets page.</p>
    </Modal>
  );
}
