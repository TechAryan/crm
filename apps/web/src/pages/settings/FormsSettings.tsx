import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

const LEAD_SYSTEM = [
  { schemaName: 'firstName', label: 'First Name' }, { schemaName: 'lastName', label: 'Last Name' },
  { schemaName: 'email', label: 'Email' }, { schemaName: 'phone', label: 'Phone' },
];

export default function FormsSettings() {
  const [forms, setForms] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [error, setError] = useState('');

  async function load() { try { setForms((await api.get('/v1/forms')).items); } catch (e: any) { setError(errMsg(e)); } }
  useEffect(() => { load(); }, []);

  async function deactivate(id: string) {
    try { await api.del(`/v1/forms/${id}`); load(); } catch (e: any) { setError(errMsg(e)); }
  }

  return (
    <div>
      <div className="page-header">
        <div><h1>Custom Forms</h1><p>Design forms from lead, opportunity and activity fields — with sections, rules and submit actions — and place them on detail pages</p></div>
        <button className="btn btn-primary" onClick={() => setEditing({})}>+ Create Form</button>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        {forms === null ? <Loading /> : forms.length === 0 ? <div className="card-body text-muted">No forms yet.</div> : (
          <table>
            <thead><tr><th>Name</th><th>Shows On</th><th>On Submit</th><th>Fields</th><th></th></tr></thead>
            <tbody>
              {forms.map(f => (
                <tr key={f.id} style={{ cursor: 'default' }}>
                  <td>{f.name}</td>
                  <td><Badge kind="primary">{f.entity} page</Badge></td>
                  <td className="text-muted">{f.on_submit?.action?.replace('_', ' ')}</td>
                  <td className="text-muted">{(f.definition?.sections || []).reduce((n: number, s: any) => n + (s.items || []).filter((i: any) => i.kind === 'field').length, 0)} fields</td>
                  <td className="flex gap-8">
                    <button className="btn btn-sm" onClick={() => setEditing(f)}>Edit</button>
                    <button className="btn btn-sm" onClick={() => deactivate(f.id)}>Deactivate</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <FormBuilderModal form={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function FormBuilderModal({ form, onClose, onSaved }: { form: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !form.id;
  const [name, setName] = useState(form.name || '');
  const [entity, setEntity] = useState(form.entity || 'lead');
  const [action, setAction] = useState(form.on_submit?.action || 'update_lead');
  const [activityTypeId, setActivityTypeId] = useState(form.on_submit?.activityTypeId || '');
  const [sections, setSections] = useState<any[]>(form.definition?.sections?.length ? JSON.parse(JSON.stringify(form.definition.sections)) : [{ title: 'Details', items: [] }]);
  const [valueRules, setValueRules] = useState<any[]>(form.definition?.valueRules || []);
  const [activityTypes, setActivityTypes] = useState<any[]>([]);
  const [availableFields, setAvailableFields] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get('/v1/activity-types').then(d => setActivityTypes(d.items.filter((t: any) => !t.is_system))); }, []);

  // available fields depend on the submit target
  useEffect(() => {
    (async () => {
      try {
        if (action === 'post_activity' && activityTypeId) {
          const d = await api.get(`/v1/activity-types/${activityTypeId}/fields`);
          setAvailableFields([
            ...d.items.map((f: any) => ({ schemaName: f.schema_name, label: f.label, source: 'activity' })),
            { schemaName: '__note', label: 'Note (free text)', source: 'activity' },
          ]);
        } else if (action === 'update_opportunity') {
          const types = await api.get('/v1/opportunity-types');
          const all: any[] = [];
          for (const t of types.items) {
            const d = await api.get(`/v1/opportunity-types/${t.id}/fields`);
            for (const f of d.items) all.push({ schemaName: f.schema_name, label: `${f.label} (${t.name})`, source: 'opportunity' });
          }
          setAvailableFields(all);
        } else {
          const d = await api.get('/v1/fields/lead');
          setAvailableFields([
            ...LEAD_SYSTEM.map(f => ({ ...f, source: 'lead' })),
            ...d.items.map((f: any) => ({ schemaName: f.schema_name, label: f.label, source: 'lead' })),
          ]);
        }
      } catch { setAvailableFields([]); }
    })();
  }, [action, activityTypeId]);

  const usedNames = new Set(sections.flatMap(s => (s.items || []).filter((i: any) => i.kind === 'field').map((i: any) => i.schemaName)));
  const allFieldNames = sections.flatMap(s => (s.items || []).filter((i: any) => i.kind === 'field').map((i: any) => ({ schemaName: i.schemaName, label: i.label })));

  function mutateSection(si: number, fn: (s: any) => void) {
    setSections(prev => { const next = JSON.parse(JSON.stringify(prev)); fn(next[si]); return next; });
  }
  function addField(si: number, f: any) { mutateSection(si, s => s.items.push({ kind: 'field', source: f.source, schemaName: f.schemaName, label: f.label, required: false })); }
  function addSubheading(si: number) {
    const text = prompt('Subheading text:');
    if (text) mutateSection(si, s => s.items.push({ kind: 'subheading', text }));
  }
  function moveItem(si: number, ii: number, dir: -1 | 1) {
    mutateSection(si, s => {
      const j = ii + dir;
      if (j < 0 || j >= s.items.length) return;
      [s.items[ii], s.items[j]] = [s.items[j], s.items[ii]];
    });
  }
  function removeItem(si: number, ii: number) { mutateSection(si, s => s.items.splice(ii, 1)); }
  function setItem(si: number, ii: number, patch: any) { mutateSection(si, s => Object.assign(s.items[ii], patch)); }

  async function save() {
    setBusy(true); setError('');
    try {
      const body = {
        name, entity,
        definition: { sections, valueRules: valueRules.filter(r => r.if?.field && r.set?.field) },
        onSubmit: action === 'post_activity' ? { action, activityTypeId } : { action },
      };
      if (isNew) await api.post('/v1/forms', body);
      else await api.patch(`/v1/forms/${form.id}`, body);
      onSaved();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={isNew ? 'Create Form' : `Edit: ${form.name}`} onClose={onClose} width={860} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name || (action === 'post_activity' && !activityTypeId)} onClick={save}>{busy ? 'Saving…' : 'Save Form'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <div className="form-row">
        <Field label="Form name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Site Visit Report" /></Field>
        <Field label="Show on">
          <select value={entity} onChange={e => setEntity(e.target.value)}>
            <option value="lead">Lead detail page</option>
            <option value="opportunity">Opportunity detail page</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="On submit">
          <select value={action} onChange={e => setAction(e.target.value)}>
            <option value="update_lead">Update the lead</option>
            <option value="update_opportunity">Update the opportunity</option>
            <option value="post_activity">Post an activity</option>
          </select>
        </Field>
        {action === 'post_activity' && (
          <Field label="Activity type">
            <select value={activityTypeId} onChange={e => setActivityTypeId(e.target.value)}>
              <option value="">Select…</option>
              {activityTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        )}
      </div>

      {sections.map((section, si) => (
        <div className="card" key={si} style={{ marginBottom: 12 }}>
          <div className="card-header">
            <input value={section.title} onChange={e => mutateSection(si, s => { s.title = e.target.value; })}
                   style={{ border: 'none', fontWeight: 700, fontSize: 13.5, width: '60%', padding: 0 }} placeholder="Section title" />
            <span className="flex gap-8">
              <button className="btn btn-sm" onClick={() => addSubheading(si)}>+ Subheading</button>
              {sections.length > 1 && <button className="btn btn-sm" onClick={() => setSections(prev => prev.filter((_, i) => i !== si))}>✕ Section</button>}
            </span>
          </div>
          <div className="card-body">
            {(section.items || []).map((item: any, ii: number) => (
              <div key={ii} className="flex gap-8 mt-8" style={{ alignItems: 'center', padding: '6px 8px', background: 'var(--bg)', borderRadius: 6 }}>
                <span className="flex" style={{ flexDirection: 'column', gap: 2 }}>
                  <button className="btn btn-sm btn-ghost" style={{ padding: '0 4px' }} onClick={() => moveItem(si, ii, -1)}>▲</button>
                  <button className="btn btn-sm btn-ghost" style={{ padding: '0 4px' }} onClick={() => moveItem(si, ii, 1)}>▼</button>
                </span>
                {item.kind === 'subheading' ? (
                  <><Badge kind="muted">subheading</Badge><strong style={{ flex: 1 }}>{item.text}</strong></>
                ) : (
                  <>
                    <span style={{ flex: 1 }}><strong>{item.label}</strong> <span className="mono small text-muted">{item.schemaName}</span></span>
                    <label className="checkbox-row small"><input type="checkbox" checked={!!item.required} onChange={e => setItem(si, ii, { required: e.target.checked })} /> Required</label>
                    <select value={item.showIf?.field || ''} style={{ width: 150 }} title="Show only if…"
                            onChange={e => setItem(si, ii, { showIf: e.target.value ? { field: e.target.value, op: item.showIf?.op || 'notEmpty', value: item.showIf?.value || '' } : undefined })}>
                      <option value="">Always show</option>
                      {allFieldNames.filter(f => f.schemaName !== item.schemaName).map(f => <option key={f.schemaName} value={f.schemaName}>if: {f.label}</option>)}
                    </select>
                    {item.showIf?.field && (
                      <>
                        <select value={item.showIf.op} style={{ width: 100 }} onChange={e => setItem(si, ii, { showIf: { ...item.showIf, op: e.target.value } })}>
                          <option value="notEmpty">has value</option><option value="eq">equals</option><option value="neq">not equals</option>
                        </select>
                        {item.showIf.op !== 'notEmpty' &&
                          <input value={item.showIf.value || ''} style={{ width: 100 }} placeholder="value" onChange={e => setItem(si, ii, { showIf: { ...item.showIf, value: e.target.value } })} />}
                      </>
                    )}
                  </>
                )}
                <button className="btn btn-sm" onClick={() => removeItem(si, ii)}>✕</button>
              </div>
            ))}
            <div className="mt-8">
              <select value="" onChange={e => { const f = availableFields.find(x => x.schemaName === e.target.value); if (f) addField(si, f); }}>
                <option value="">+ Add field…</option>
                {availableFields.filter(f => !usedNames.has(f.schemaName)).map(f => <option key={f.schemaName} value={f.schemaName}>{f.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setSections(prev => [...prev, { title: 'New Section', items: [] }])}>+ Add Section</button>

      <div className="card mt-16">
        <div className="card-header">Value Rules <button className="btn btn-sm" onClick={() => setValueRules(r => [...r, { if: { field: '', op: 'eq', value: '' }, set: { field: '', value: '' } }])}>+ Rule</button></div>
        <div className="card-body">
          <p className="small text-muted">If a field has a value, automatically set another field on submit.</p>
          {valueRules.map((r, i) => (
            <div className="flex gap-8 mt-8" key={i} style={{ alignItems: 'center' }}>
              <span className="small">If</span>
              <select value={r.if.field} style={{ flex: 1 }} onChange={e => setValueRules(rs => rs.map((x, j) => j === i ? { ...x, if: { ...x.if, field: e.target.value } } : x))}>
                <option value="">field…</option>
                {allFieldNames.map(f => <option key={f.schemaName} value={f.schemaName}>{f.label}</option>)}
              </select>
              <select value={r.if.op} onChange={e => setValueRules(rs => rs.map((x, j) => j === i ? { ...x, if: { ...x.if, op: e.target.value } } : x))}>
                <option value="eq">equals</option><option value="neq">not equals</option><option value="notEmpty">has value</option>
              </select>
              {r.if.op !== 'notEmpty' && <input value={r.if.value} placeholder="value" style={{ width: 90 }} onChange={e => setValueRules(rs => rs.map((x, j) => j === i ? { ...x, if: { ...x.if, value: e.target.value } } : x))} />}
              <span className="small">then set</span>
              <select value={r.set.field} style={{ flex: 1 }} onChange={e => setValueRules(rs => rs.map((x, j) => j === i ? { ...x, set: { ...x.set, field: e.target.value } } : x))}>
                <option value="">field…</option>
                {allFieldNames.map(f => <option key={f.schemaName} value={f.schemaName}>{f.label}</option>)}
              </select>
              <span className="small">=</span>
              <input value={r.set.value} placeholder="value" style={{ width: 90 }} onChange={e => setValueRules(rs => rs.map((x, j) => j === i ? { ...x, set: { ...x.set, value: e.target.value } } : x))} />
              <button className="btn btn-sm" onClick={() => setValueRules(rs => rs.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
