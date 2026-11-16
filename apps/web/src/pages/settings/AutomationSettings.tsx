import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';
import { FeatureLock, useFeatures } from '../../components/FeatureLock';

const EVENT_LABELS: Record<string, string> = {
  created: 'is created',
  updated: 'is updated (any change)',
  field_changed: 'a specific field changes',
  stage_changed: 'the stage changes',
  deleted: 'is deleted',
};

const ACTION_LABELS: Record<string, string> = {
  update_lead: 'Update the lead',
  update_opportunity: 'Update the opportunity',
  create_opportunity: 'Create an opportunity',
  create_task: 'Create a task',
  create_activity: 'Log an activity',
  reassign_owner: 'Reassign owner',
  http_call: 'Call an external API',
};

export default function AutomationSettings() {
  const [rules, setRules] = useState<any[] | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [logsFor, setLogsFor] = useState<any>(null);
  const [error, setError] = useState('');
  const { enabled, loading } = useFeatures();

  async function load() {
    try {
      const [r, m] = await Promise.all([api.get('/v1/automation'), api.get('/v1/automation/meta')]);
      setRules(r.items); setMeta(m);
    } catch (e: any) { setError(errMsg(e)); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(r: any) {
    try { await api.patch(`/v1/automation/${r.id}`, { isActive: !r.is_active }); load(); }
    catch (e: any) { setError(errMsg(e)); }
  }
  async function remove(r: any) {
    if (!confirm(`Delete automation "${r.name}"?`)) return;
    try { await api.del(`/v1/automation/${r.id}`); load(); } catch (e: any) { setError(errMsg(e)); }
  }

  function describeTrigger(t: any) {
    let s = `When a ${t.entity} ${EVENT_LABELS[t.event] || t.event}`;
    if (t.event === 'field_changed' && t.field) s += ` (${t.field})`;
    if (t.toValue) s += ` → "${t.toValue}"`;
    return s;
  }

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div><h1>Automation</h1><p>When something happens, do something — update records or call your APIs</p></div>
        {enabled.automation && <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Rule</button>}
      </div>
      {error && <Alert>{error}</Alert>}
      {!enabled.automation && <FeatureLock feature="automation" />}

      <div className="card">
        {rules === null ? <Loading /> : rules.length === 0 ? (
          <div className="card-body text-muted">No automation rules yet.</div>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Trigger</th><th>Actions</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.id} style={{ cursor: 'default' }}>
                  <td><strong>{r.name}</strong>{r.description && <div className="text-muted small">{r.description}</div>}</td>
                  <td className="small">{describeTrigger(r.trigger)}</td>
                  <td className="small">{(r.actions || []).map((a: any) => ACTION_LABELS[a.type] || a.type).join(', ')}</td>
                  <td><Badge kind={r.is_active ? 'success' : 'muted'}>{r.is_active ? 'Active' : 'Paused'}</Badge></td>
                  <td className="flex gap-8">
                    <button className="btn btn-sm" onClick={() => setLogsFor(r)}>Logs</button>
                    <button className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>
                    <button className="btn btn-sm" onClick={() => toggle(r)}>{r.is_active ? 'Pause' : 'Resume'}</button>
                    <button className="btn btn-sm" onClick={() => remove(r)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(showCreate || editing) && meta && (
        <RuleModal rule={editing} meta={meta} onClose={() => { setShowCreate(false); setEditing(null); }}
          onDone={() => { setShowCreate(false); setEditing(null); load(); }} />
      )}
      {logsFor && <ExecutionLogModal rule={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  );
}

function RuleModal({ rule, meta, onClose, onDone }: { rule: any; meta: any; onClose: () => void; onDone: () => void }) {
  const isEdit = !!rule;
  const [name, setName] = useState(rule?.name || '');
  const [description, setDescription] = useState(rule?.description || '');
  const [trigger, setTrigger] = useState<any>(rule?.trigger || { entity: 'lead', event: 'created' });
  const [conditions, setConditions] = useState<any[]>(rule?.conditions || []);
  const [actions, setActions] = useState<any[]>(rule?.actions || []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setT = (k: string, v: any) => setTrigger((t: any) => ({ ...t, [k]: v }));

  async function submit() {
    setBusy(true); setError('');
    try {
      if (!actions.length) throw new Error('Add at least one action');
      const body = { name, description, trigger, conditions, actions };
      if (isEdit) await api.patch(`/v1/automation/${rule.id}`, body);
      else await api.post('/v1/automation', body);
      onDone();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  function addAction(type: string) {
    const defaults: Record<string, any> = {
      update_lead: { type, patch: { stage: '' } },
      update_opportunity: { type, patch: { stage: '' } },
      create_opportunity: { type, name: 'New Opportunity' },
      create_task: { type, name: 'Follow up', kind: 'todo', dueInDays: 1, ownerId: 'record_owner' },
      create_activity: { type, typeName: '', note: '' },
      reassign_owner: { type, ownerId: '' },
      http_call: { type, method: 'POST', url: '', body: '' },
    };
    setActions(a => [...a, defaults[type] || { type }]);
  }
  const updAction = (i: number, patch: any) => setActions(a => a.map((x, idx) => idx === i ? { ...x, ...patch } : x));
  const updActionPatch = (i: number, patch: any) =>
    setActions(a => a.map((x, idx) => idx === i ? { ...x, patch: { ...(x.patch || {}), ...patch } } : x));

  const tokens = meta.tokens?.[trigger.entity === 'task' ? 'lead' : trigger.entity] || [];

  return (
    <Modal title={isEdit ? 'Edit Automation Rule' : 'New Automation Rule'} onClose={onClose} width={820} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Rule'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}

      <Field label="Rule name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Chase demo no-shows" /></Field>
      <Field label="Description (optional)"><input value={description} onChange={e => setDescription(e.target.value)} /></Field>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-header">1. Trigger — when this happens</div>
        <div className="card-body">
          <div className="form-row">
            <Field label="Entity">
              <select value={trigger.entity} onChange={e => setT('entity', e.target.value)}>
                {(meta.entities || []).map((x: string) => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Event">
              <select value={trigger.event} onChange={e => setT('event', e.target.value)}>
                {(meta.events || []).map((x: string) => <option key={x} value={x}>{EVENT_LABELS[x] || x}</option>)}
              </select>
            </Field>
          </div>
          {trigger.event === 'field_changed' && (
            <Field label="Which field" hint="Use a field name like stage, owner, or fields.mx_city">
              <input className="mono" value={trigger.field || ''} onChange={e => setT('field', e.target.value)} placeholder="fields.mx_city" />
            </Field>
          )}
          {(trigger.event === 'field_changed' || trigger.event === 'stage_changed') && (
            <div className="form-row">
              <Field label="Only when new value is" hint="Leave blank for any change">
                {trigger.event === 'stage_changed' || trigger.field === 'stage' ? (
                  <select value={trigger.toValue || ''} onChange={e => setT('toValue', e.target.value)}>
                    <option value="">Any value</option>
                    {(meta.stages || []).map((s: string) => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <input value={trigger.toValue || ''} onChange={e => setT('toValue', e.target.value)} />
                )}
              </Field>
              <Field label="Only when old value was" hint="Optional">
                <input value={trigger.fromValue || ''} onChange={e => setT('fromValue', e.target.value)} />
              </Field>
            </div>
          )}
          {trigger.entity === 'activity' && (
            <Field label="Only this activity type" hint="Leave blank for any activity type">
              <select value={trigger.activityTypeId || ''} onChange={e => setT('activityTypeId', e.target.value || undefined)}>
                <option value="">Any activity type</option>
                {(meta.activityTypes || []).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-header">2. Conditions — only if (optional)</div>
        <div className="card-body">
          {conditions.map((c, i) => (
            <div className="flex gap-8 mt-8" key={i}>
              <input placeholder="field (e.g. fields.mx_city)" className="mono" value={c.field || ''}
                onChange={e => setConditions(cs => cs.map((x, idx) => idx === i ? { ...x, field: e.target.value } : x))} style={{ flex: 2 }} />
              <select value={c.op || 'eq'} onChange={e => setConditions(cs => cs.map((x, idx) => idx === i ? { ...x, op: e.target.value } : x))} style={{ flex: 1 }}>
                <option value="eq">is</option><option value="neq">is not</option>
                <option value="contains">contains</option><option value="exists">is not empty</option>
              </select>
              {c.op !== 'exists' && (
                <input placeholder="value" value={c.value || ''}
                  onChange={e => setConditions(cs => cs.map((x, idx) => idx === i ? { ...x, value: e.target.value } : x))} style={{ flex: 1 }} />
              )}
              <button className="btn btn-sm" onClick={() => setConditions(cs => cs.filter((_, idx) => idx !== i))}>✕</button>
            </div>
          ))}
          <button className="btn btn-sm mt-8" onClick={() => setConditions(cs => [...cs, { field: '', op: 'eq', value: '' }])}>+ Add condition</button>
        </div>
      </div>

      <div className="card">
        <div className="card-header">3. Actions — then do this</div>
        <div className="card-body">
          {actions.map((a, i) => (
            <div className="card" key={i} style={{ marginBottom: 8 }}>
              <div className="card-header" style={{ padding: '8px 12px' }}>
                <span>{ACTION_LABELS[a.type] || a.type}</span>
                <button className="btn btn-sm" onClick={() => setActions(x => x.filter((_, idx) => idx !== i))}>Remove</button>
              </div>
              <div className="card-body" style={{ padding: 12 }}>
                {a.type === 'update_lead' && (
                  <div className="form-row">
                    <Field label="Set stage to">
                      <select value={a.patch?.stage || ''} onChange={e => updActionPatch(i, { stage: e.target.value })}>
                        <option value="">— no change —</option>
                        {(meta.stages || []).map((s: string) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </Field>
                    <Field label="Set fields (JSON)" hint='e.g. {"mx_priority":"High"}'>
                      <input className="mono" defaultValue={a.patch?.fields ? JSON.stringify(a.patch.fields) : ''}
                        onBlur={e => { try { updActionPatch(i, { fields: e.target.value ? JSON.parse(e.target.value) : undefined }); } catch { alert('Fields must be valid JSON'); } }} />
                    </Field>
                  </div>
                )}
                {a.type === 'update_opportunity' && (
                  <Field label="Set stage to"><input value={a.patch?.stage || ''} onChange={e => updActionPatch(i, { stage: e.target.value })} placeholder="Closed Won" /></Field>
                )}
                {a.type === 'create_opportunity' && (
                  <Field label="Opportunity name"><input value={a.name || ''} onChange={e => updAction(i, { name: e.target.value })} /></Field>
                )}
                {a.type === 'create_task' && (
                  <div className="form-row">
                    <Field label="Task name"><input value={a.name || ''} onChange={e => updAction(i, { name: e.target.value })} /></Field>
                    <Field label="Due in (days)"><input type="number" value={a.dueInDays ?? 1} onChange={e => updAction(i, { dueInDays: Number(e.target.value) })} /></Field>
                  </div>
                )}
                {a.type === 'create_activity' && (
                  <div className="form-row">
                    <Field label="Activity type">
                      <select value={a.typeName || ''} onChange={e => updAction(i, { typeName: e.target.value })}>
                        <option value="">Select…</option>
                        {(meta.activityTypes || []).map((t: any) => <option key={t.id} value={t.name}>{t.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Note"><input value={a.note || ''} onChange={e => updAction(i, { note: e.target.value })} /></Field>
                  </div>
                )}
                {a.type === 'reassign_owner' && (
                  <Field label="New owner (user id)"><input className="mono" value={a.ownerId || ''} onChange={e => updAction(i, { ownerId: e.target.value })} /></Field>
                )}
                {a.type === 'http_call' && (
                  <>
                    <div className="form-row">
                      <Field label="Method">
                        <select value={a.method || 'POST'} onChange={e => updAction(i, { method: e.target.value })}>
                          {['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </Field>
                      <Field label="URL (https only)">
                        <input className="mono" value={a.url || ''} onChange={e => updAction(i, { url: e.target.value })}
                          placeholder="https://hooks.example.com/notify" />
                      </Field>
                    </div>
                    <Field label="Body (merge tokens supported)">
                      <textarea rows={3} className="mono" value={a.body || ''} onChange={e => updAction(i, { body: e.target.value })}
                        placeholder={'{"lead":"{{lead.full_name}}","phone":"{{lead.phone}}"}'} />
                    </Field>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
            {Object.entries(ACTION_LABELS).map(([type, label]) => (
              <button key={type} className="btn btn-sm" onClick={() => addAction(type)}>+ {label}</button>
            ))}
          </div>
          {tokens.length > 0 && (
            <div className="mt-16">
              <div className="small text-muted">Merge tokens (click to copy)</div>
              <div className="flex gap-8" style={{ flexWrap: 'wrap', marginTop: 4, maxHeight: 90, overflow: 'auto' }}>
                {tokens.map((t: any) => (
                  <span key={t.token} className="badge badge-muted mono" style={{ cursor: 'pointer' }} title={t.label}
                    onClick={() => navigator.clipboard?.writeText(t.token)}>{t.token}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Per-rule execution log — the thing that makes automation debuggable. */
function ExecutionLogModal({ rule, onClose }: { rule: any; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/v1/automation/executions?ruleId=${rule.id}&limit=50`)
      .then(d => setRows(d.items)).catch(e => setError(errMsg(e)));
  }, [rule.id]);

  return (
    <Modal title={`Execution log — ${rule.name}`} onClose={onClose} width={720}
      footer={<button className="btn btn-primary" onClick={onClose}>Close</button>}>
      {error && <Alert>{error}</Alert>}
      {rows === null ? <Loading /> : rows.length === 0 ? (
        <p className="text-muted">This rule hasn't run yet.</p>
      ) : (
        <table>
          <thead><tr><th>When</th><th>Record</th><th>Status</th><th>Steps</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ cursor: 'default' }}>
                <td className="small">{new Date(r.created_at).toLocaleString()}</td>
                <td className="mono small">{(r.entity_id || '').slice(0, 8)}</td>
                <td>
                  <Badge kind={r.status === 'success' ? 'success' : r.status === 'skipped' ? 'muted' : r.status === 'partial' ? 'warning' : 'danger'}>
                    {r.status}
                  </Badge>
                </td>
                <td className="small">
                  {(r.steps || []).map((s: any, i: number) => (
                    <div key={i}>{s.status === 'success' ? '✓' : '✗'} {s.action}{s.detail ? ` — ${s.detail}` : ''}</div>
                  ))}
                  {r.error && <div style={{ color: 'var(--danger)' }}>{r.error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
