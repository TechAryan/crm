import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

const ENTITIES = ['lead', 'activity', 'opportunity', 'task', 'user'] as const;
const SCOPED_ACTIONS = ['view', 'edit', 'delete'] as const;
const BOOL_ACTIONS = ['create', 'import', 'export'] as const;
const SETTINGS_KEYS = ['manageFields', 'manageRoles', 'manageAutomation', 'manageWebhooks', 'manageConnectors', 'manageDistribution'];
const SCOPES = [
  { value: 'false', label: 'None' }, { value: 'own', label: 'Own' }, { value: 'team', label: 'Team' }, { value: 'all', label: 'All' },
];

function emptyPerms(): any {
  const p: any = { settings: {}, reports: { view: false } };
  for (const e of ENTITIES) p[e] = { view: false, create: false, edit: false, delete: false, import: false, export: false, fieldRules: { hidden: [], readonly: [] } };
  return p;
}

export default function PermissionSetsSettings() {
  const [sets, setSets] = useState<any[] | null>(null);
  const [roles, setRoles] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null); // {id?, name, permissions}
  const [assigning, setAssigning] = useState<any | null>(null);
  const [error, setError] = useState('');

  async function load() {
    try {
      const [s, r, u] = await Promise.all([api.get('/v1/permission-sets'), api.get('/v1/roles'), api.get('/v1/users').catch(() => ({ items: [] }))]);
      setSets(s.items); setRoles(r.items); setUsers(u.items);
    } catch (e: any) { setError(errMsg(e)); }
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="page-header">
        <div><h1>Permission Sets</h1><p>Define what actions are allowed; attach sets to roles or individual users. Multiple sets stack (most permissive wins; field masks always apply).</p></div>
        <button className="btn btn-primary" onClick={() => setEditing({ name: '', permissions: emptyPerms() })}>+ New Permission Set</button>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        {sets === null ? <Loading /> : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Summary</th><th></th></tr></thead>
            <tbody>
              {sets.map(s => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.is_system ? <Badge kind="muted">system</Badge> : <Badge kind="primary">custom</Badge>}</td>
                  <td className="text-muted small">{summarize(s.permissions)}</td>
                  <td className="flex gap-8">
                    <button className="btn btn-sm" onClick={() => setEditing({ id: s.id, name: s.name, permissions: mergeShape(s.permissions) })}>Edit</button>
                    <button className="btn btn-sm" onClick={() => setAssigning(s)}>Assign</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <EditorModal set={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {assigning && <AssignModal set={assigning} roles={roles} users={users} onClose={() => setAssigning(null)} />}
    </div>
  );
}

function summarize(p: any): string {
  const parts: string[] = [];
  for (const e of ENTITIES) {
    const v = p?.[e]?.view;
    if (v && v !== false) parts.push(`${e}:${v}`);
  }
  const settings = Object.entries(p?.settings || {}).filter(([, v]) => v).map(([k]) => k);
  if (settings.length) parts.push(`settings(${settings.length})`);
  return parts.join(', ') || 'No access';
}

function mergeShape(p: any): any {
  const base = emptyPerms();
  for (const e of ENTITIES) base[e] = { ...base[e], ...(p?.[e] || {}) };
  base.settings = { ...(p?.settings || {}) };
  base.reports = { view: !!p?.reports?.view };
  return base;
}

function EditorModal({ set, onClose, onSaved }: { set: any; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(set.name);
  const [perms, setPerms] = useState<any>(set.permissions);
  // Per-entity, per-channel field rules held as comma-separated text for editing.
  const [fieldRules, setFieldRules] = useState<Record<string, Record<string, string>>>(() => {
    const init: Record<string, Record<string, string>> = {};
    for (const e of ENTITIES) {
      const fr = set.permissions?.[e]?.fieldRules || {};
      init[e] = {
        hidden: (fr.hidden || []).join(', '),
        readonly: (fr.readonly || []).join(', '),
        readonlyManual: (fr.readonlyManual || []).join(', '),
        readonlyApi: (fr.readonlyApi || []).join(', '),
      };
    }
    return init;
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setFieldRule = (entity: string, key: string, value: string) =>
    setFieldRules(fr => ({ ...fr, [entity]: { ...(fr[entity] || {}), [key]: value } }));

  function setScope(entity: string, action: string, raw: string) {
    const value = raw === 'false' ? false : raw;
    setPerms((p: any) => ({ ...p, [entity]: { ...p[entity], [action]: value } }));
  }
  function setBool(entity: string, action: string, checked: boolean) {
    setPerms((p: any) => ({ ...p, [entity]: { ...p[entity], [action]: checked } }));
  }
  function setSetting(key: string, checked: boolean) {
    setPerms((p: any) => ({ ...p, settings: { ...p.settings, [key]: checked } }));
  }

  async function save() {
    setBusy(true); setError('');
    try {
      const split = (s: string) => (s || '').split(',').map(x => x.trim()).filter(Boolean);
      const permissions: any = { ...perms };
      for (const e of ENTITIES) {
        const fr = fieldRules[e] || {};
        permissions[e] = {
          ...perms[e],
          fieldRules: {
            hidden: split(fr.hidden), readonly: split(fr.readonly),
            readonlyManual: split(fr.readonlyManual), readonlyApi: split(fr.readonlyApi),
          },
        };
      }
      if (set.id) await api.patch(`/v1/permission-sets/${set.id}`, { name, permissions });
      else await api.post('/v1/permission-sets', { name, permissions });
      onSaved();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={set.id ? `Edit: ${set.name}` : 'New Permission Set'} onClose={onClose} width={760} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
      <table style={{ marginBottom: 16 }}>
        <thead><tr><th>Entity</th><th>View</th><th>Edit</th><th>Delete</th><th>Create</th><th>Import</th><th>Export</th></tr></thead>
        <tbody>
          {ENTITIES.map(e => (
            <tr key={e} style={{ cursor: 'default' }}>
              <td style={{ textTransform: 'capitalize', fontWeight: 600 }}>{e}</td>
              {SCOPED_ACTIONS.map(a => (
                <td key={a}>
                  <select value={String(perms[e][a] ?? 'false')} onChange={ev => setScope(e, a, ev.target.value)} style={{ width: 90 }}>
                    {SCOPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </td>
              ))}
              {BOOL_ACTIONS.map(a => (
                <td key={a}><input type="checkbox" style={{ width: 'auto' }} checked={!!perms[e][a]} onChange={ev => setBool(e, a, ev.target.checked)} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">Field-level security</div>
        <div className="card-body">
          <p className="small text-muted">
            Comma-separated schema names (e.g. <span className="mono">mx_budget, phone</span>).
            "Manual" means a person editing in the UI; "API" means an API key / integration —
            so you can let an integration write a field that humans can't, or vice versa.
          </p>
          {ENTITIES.filter(e => ['lead', 'opportunity', 'activity'].includes(e)).map(e => (
            <div key={e} style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, textTransform: 'capitalize', marginBottom: 6 }}>{e}</div>
              <div className="form-row">
                <Field label="Hidden" hint="Not visible or writable at all">
                  <input className="mono" value={fieldRules[e]?.hidden || ''} onChange={ev => setFieldRule(e, 'hidden', ev.target.value)} />
                </Field>
                <Field label="Read-only (both channels)">
                  <input className="mono" value={fieldRules[e]?.readonly || ''} onChange={ev => setFieldRule(e, 'readonly', ev.target.value)} />
                </Field>
              </div>
              <div className="form-row">
                <Field label="Read-only in UI (API may write)">
                  <input className="mono" value={fieldRules[e]?.readonlyManual || ''} onChange={ev => setFieldRule(e, 'readonlyManual', ev.target.value)} />
                </Field>
                <Field label="Read-only via API (UI may write)">
                  <input className="mono" value={fieldRules[e]?.readonlyApi || ''} onChange={ev => setFieldRule(e, 'readonlyApi', ev.target.value)} />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Field label="Settings permissions" hint="Who can customize what — LSQ-style delegated administration">
        <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
          {SETTINGS_KEYS.map(k => (
            <label key={k} className="checkbox-row badge badge-muted" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={!!perms.settings[k]} onChange={e => setSetting(k, e.target.checked)} /> {k}
            </label>
          ))}
          <label className="checkbox-row badge badge-muted" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={!!perms.reports?.view} onChange={e => setPerms((p: any) => ({ ...p, reports: { view: e.target.checked } }))} /> viewReports
          </label>
        </div>
      </Field>
    </Modal>
  );
}

function AssignModal({ set, roles, users, onClose }: { set: any; roles: any[]; users: any[]; onClose: () => void }) {
  const [roleId, setRoleId] = useState('');
  const [userId, setUserId] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function assign() {
    setBusy(true); setMsg(null);
    try {
      await api.post('/v1/permission-sets/assign', { permissionSetId: set.id, roleId: roleId || undefined, userId: userId || undefined });
      setMsg({ kind: 'success', text: 'Assigned. Users pick it up on next login/refresh.' });
    } catch (e: any) { setMsg({ kind: 'danger', text: errMsg(e) }); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Assign: ${set.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Close</button>
      <button className="btn btn-primary" disabled={busy || (!roleId && !userId)} onClick={assign}>{busy ? 'Assigning…' : 'Assign'}</button>
    </>}>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <Field label="Attach to role (applies to every user with that role)">
        <select value={roleId} onChange={e => setRoleId(e.target.value)}>
          <option value="">—</option>
          {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="Or attach to an individual user">
        <select value={userId} onChange={e => setUserId(e.target.value)}>
          <option value="">—</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.first_name} {u.last_name} ({u.email})</option>)}
        </select>
      </Field>
    </Modal>
  );
}
