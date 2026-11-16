import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';
import { FeatureLock, useFeatures } from '../../components/FeatureLock';

const ENTITIES = ['lead', 'opportunity', 'activity'];

/** Admin-defined buttons on record pages that call the tenant's own API with merged field data. */
export default function CustomActionsSettings() {
  const [actions, setActions] = useState<any[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');
  const { enabled, loading } = useFeatures();

  async function load() {
    try { setActions((await api.get('/v1/custom-actions')).items); } catch (e: any) { setError(errMsg(e)); }
  }
  useEffect(() => { load(); }, []);

  async function remove(a: any) {
    if (!confirm(`Delete action "${a.name}"?`)) return;
    try { await api.del(`/v1/custom-actions/${a.id}`); load(); } catch (e: any) { setError(errMsg(e)); }
  }
  async function toggle(a: any) {
    try { await api.patch(`/v1/custom-actions/${a.id}`, { isActive: !a.is_active }); load(); }
    catch (e: any) { setError(errMsg(e)); }
  }

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div><h1>Custom Actions</h1><p>Buttons on records that call your own APIs with lead/opportunity data</p></div>
        {enabled.custom_actions && <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Action</button>}
      </div>
      {error && <Alert>{error}</Alert>}
      {!enabled.custom_actions && <FeatureLock feature="custom_actions" />}

      <div className="card">
        {actions === null ? <Loading /> : actions.length === 0 ? (
          <div className="card-body text-muted">No custom actions yet. Create one to add a button to your lead or opportunity pages.</div>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Entity</th><th>Method</th><th>URL</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {actions.map(a => (
                <tr key={a.id} style={{ cursor: 'default' }}>
                  <td><strong>{a.name}</strong>{a.confirm_text && <span className="text-muted small"> (confirms)</span>}</td>
                  <td><Badge kind="primary">{a.entity}</Badge></td>
                  <td>{a.open_url_in_new_tab ? <Badge kind="muted">Open URL</Badge> : a.method}</td>
                  <td className="mono small" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.url_template}</td>
                  <td><Badge kind={a.is_active ? 'success' : 'muted'}>{a.is_active ? 'Active' : 'Paused'}</Badge></td>
                  <td className="flex gap-8">
                    <button className="btn btn-sm" onClick={() => setEditing(a)}>Edit</button>
                    <button className="btn btn-sm" onClick={() => toggle(a)}>{a.is_active ? 'Pause' : 'Resume'}</button>
                    <button className="btn btn-sm" onClick={() => remove(a)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(showCreate || editing) && (
        <ActionModal action={editing} onClose={() => { setShowCreate(false); setEditing(null); }}
          onDone={() => { setShowCreate(false); setEditing(null); load(); }} />
      )}
    </div>
  );
}

function ActionModal({ action, onClose, onDone }: { action: any; onClose: () => void; onDone: () => void }) {
  const isEdit = !!action;
  const [form, setForm] = useState<any>({
    name: action?.name || '', entity: action?.entity || 'lead',
    method: action?.method || 'POST', urlTemplate: action?.url_template || '',
    headersText: JSON.stringify(action?.headers || {}, null, 2),
    bodyTemplate: action?.body_template || '',
    confirmText: action?.confirm_text || '', successMessage: action?.success_message || '',
    requiredPermission: action?.required_permission || '',
    openUrlInNewTab: action?.open_url_in_new_tab || false,
  });
  const [tokens, setTokens] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  useEffect(() => {
    api.get(`/v1/custom-actions/tokens/${form.entity}`).then(d => setTokens(d.items)).catch(() => setTokens([]));
  }, [form.entity]);

  async function submit() {
    setBusy(true); setError('');
    try {
      let headers: any = {};
      if (form.headersText.trim()) {
        try { headers = JSON.parse(form.headersText); }
        catch { throw new Error('Headers must be valid JSON, e.g. {"Authorization": "Bearer xyz"}'); }
      }
      const body = {
        name: form.name, entity: form.entity, method: form.method, urlTemplate: form.urlTemplate,
        headers, bodyTemplate: form.bodyTemplate || undefined,
        confirmText: form.confirmText || undefined, successMessage: form.successMessage || undefined,
        requiredPermission: form.requiredPermission || undefined, openUrlInNewTab: form.openUrlInNewTab,
      };
      if (isEdit) await api.patch(`/v1/custom-actions/${action.id}`, body);
      else await api.post('/v1/custom-actions', body);
      onDone();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  const groups = [...new Set(tokens.map(t => t.group))];

  return (
    <Modal title={isEdit ? 'Edit Custom Action' : 'New Custom Action'} onClose={onClose} width={780} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !form.name || !form.urlTemplate} onClick={submit}>
        {busy ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Action'}
      </button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <div className="form-row">
        <Field label="Button label"><input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Send to Dialer" /></Field>
        <Field label="Show on">
          <select value={form.entity} disabled={isEdit} onChange={e => set('entity', e.target.value)}>
            {ENTITIES.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
      </div>

      <label className="checkbox-row" style={{ cursor: 'pointer', marginBottom: 12 }}>
        <input type="checkbox" checked={form.openUrlInNewTab} onChange={e => set('openUrlInNewTab', e.target.checked)} />
        {' '}Just open the URL in a new tab (don't call it from the server)
      </label>

      <div className="form-row">
        {!form.openUrlInNewTab && (
          <Field label="Method">
            <select value={form.method} onChange={e => set('method', e.target.value)}>
              {['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        )}
        <Field label="Required permission" hint="Leave blank to allow anyone who can view the record">
          <select value={form.requiredPermission} onChange={e => set('requiredPermission', e.target.value)}>
            <option value="">Anyone</option>
            <option value="manageRoles">Settings admins only</option>
            <option value="manageDistribution">Distribution managers</option>
          </select>
        </Field>
      </div>

      <Field label="URL" hint="https only. Use merge tokens from the reference below.">
        <input className="mono" value={form.urlTemplate} onChange={e => set('urlTemplate', e.target.value)}
          placeholder="https://api.yourdialer.com/call?to={{lead.phone}}" />
      </Field>

      {!form.openUrlInNewTab && (
        <>
          <Field label="Headers (JSON)" hint="Sent server-side, so API keys here are never exposed to the browser.">
            <textarea rows={3} className="mono" value={form.headersText} onChange={e => set('headersText', e.target.value)} />
          </Field>
          <Field label="Request body" hint="Merge tokens are JSON-escaped automatically, so quotes in data won't break the payload.">
            <textarea rows={4} className="mono" value={form.bodyTemplate} onChange={e => set('bodyTemplate', e.target.value)}
              placeholder={'{\n  "phone": "{{lead.phone}}",\n  "name": "{{lead.full_name}}",\n  "agent": "{{owner.email}}"\n}'} />
          </Field>
        </>
      )}

      <div className="form-row">
        <Field label="Confirmation prompt" hint="Leave blank for no confirmation">
          <input value={form.confirmText} onChange={e => set('confirmText', e.target.value)} placeholder="Send this lead to the dialer?" />
        </Field>
        <Field label="Success message">
          <input value={form.successMessage} onChange={e => set('successMessage', e.target.value)} placeholder="Sent to dialer" />
        </Field>
      </div>

      <div className="card" style={{ marginTop: 8 }}>
        <div className="card-header">Available merge tokens — click to copy</div>
        <div className="card-body" style={{ maxHeight: 200, overflow: 'auto' }}>
          {groups.map(g => (
            <div key={g} className="mt-8">
              <div className="small text-muted">{g}</div>
              <div className="flex gap-8" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                {tokens.filter(t => t.group === g).map(t => (
                  <span key={t.token} className="badge badge-muted mono" style={{ cursor: 'pointer' }}
                    title={`${t.label} — click to copy`}
                    onClick={() => navigator.clipboard?.writeText(t.token)}>{t.token}</span>
                ))}
              </div>
            </div>
          ))}
          {!tokens.length && <span className="text-muted small">Loading tokens…</span>}
        </div>
      </div>
    </Modal>
  );
}
