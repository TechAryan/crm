import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';
import { FIELD_TYPES } from '../../components/DynamicFields';

export default function ActivityTypesSettings() {
  const [types, setTypes] = useState<any[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [manageFieldsFor, setManageFieldsFor] = useState<any | null>(null);
  const [error, setError] = useState('');

  async function load() { try { setTypes((await api.get('/v1/activity-types')).items); } catch (e: any) { setError(errMsg(e)); } }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="page-header">
        <div><h1>Custom Activities & Scores</h1><p>Activity types define what your team logs on leads — each with its own fields and lead-score impact</p></div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Create Activity Type</button>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        {types === null ? <Loading /> : (
          <table>
            <thead><tr><th>Name</th><th>Direction</th><th>Score</th><th>Type</th><th></th></tr></thead>
            <tbody>
              {types.map(t => (
                <tr key={t.id} style={{ cursor: 'default' }}>
                  <td>{t.name}</td>
                  <td>{t.direction === 0 ? 'Inbound' : 'Outbound'}</td>
                  <td>{t.score > 0 ? `+${t.score}` : t.score}</td>
                  <td>{t.is_system ? <Badge kind="muted">system</Badge> : <Badge kind="primary">custom</Badge>}</td>
                  <td>{!t.is_system && <button className="btn btn-sm" onClick={() => setManageFieldsFor(t)}>Manage Fields</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showCreate && <CreateTypeModal onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />}
      {manageFieldsFor && <TypeFieldsModal type={manageFieldsFor} onClose={() => setManageFieldsFor(null)} />}
    </div>
  );
}

function CreateTypeModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [direction, setDirection] = useState(0);
  const [score, setScore] = useState(0);
  const [fields, setFields] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function addField() { setFields(f => [...f, { label: '', type: 'text', mandatory: false, options: '' }]); }
  function setField(i: number, k: string, v: any) { setFields(f => f.map((x, idx) => idx === i ? { ...x, [k]: v } : x)); }

  async function submit() {
    setBusy(true); setError('');
    try {
      await api.post('/v1/activity-types', {
        name, direction, score,
        fields: fields.filter(f => f.label).map(f => ({
          label: f.label, type: f.type, mandatory: f.mandatory,
          options: ['dropdown', 'multiselect'].includes(f.type) ? f.options.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
        })),
      });
      onDone();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Create Activity Type" onClose={onClose} width={640} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name} onClick={submit}>{busy ? 'Saving…' : 'Create'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <div className="form-row">
        <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Site Visit" /></Field>
        <Field label="Lead score impact" hint="Added to lead score whenever posted (can be negative)">
          <input type="number" value={score} onChange={e => setScore(Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Direction">
        <select value={direction} onChange={e => setDirection(Number(e.target.value))}>
          <option value={0}>Inbound (customer did something)</option>
          <option value={1}>Outbound (your team did something)</option>
        </select>
      </Field>
      <Field label="Activity fields" hint="Each activity type carries its own field schema — filled when posting the activity">
        {fields.map((f, i) => (
          <div className="flex gap-8 mt-8" key={i}>
            <input placeholder="Field label" value={f.label} onChange={e => setField(i, 'label', e.target.value)} style={{ flex: 2 }} />
            <select value={f.type} onChange={e => setField(i, 'type', e.target.value)} style={{ flex: 1 }}>
              {FIELD_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
            {['dropdown', 'multiselect'].includes(f.type) &&
              <input placeholder="Options, comma sep" value={f.options} onChange={e => setField(i, 'options', e.target.value)} style={{ flex: 2 }} />}
            <label className="checkbox-row small"><input type="checkbox" checked={f.mandatory} onChange={e => setField(i, 'mandatory', e.target.checked)} /> Req</label>
          </div>
        ))}
        <button className="btn btn-sm mt-8" onClick={addField}>+ Add field</button>
      </Field>
    </Modal>
  );
}

function TypeFieldsModal({ type, onClose }: { type: any; onClose: () => void }) {
  const [fields, setFields] = useState<any[] | null>(null);
  useEffect(() => { api.get(`/v1/activity-types/${type.id}/fields`).then(d => setFields(d.items)); }, [type.id]);

  return (
    <Modal title={`Fields: ${type.name}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {fields === null ? <Loading /> : fields.length === 0 ? <p className="text-muted">No fields defined for this type.</p> : (
        <table>
          <thead><tr><th>Label</th><th>Schema</th><th>Type</th><th>Mandatory</th></tr></thead>
          <tbody>{fields.map(f => (
            <tr key={f.id} style={{ cursor: 'default' }}><td>{f.label}</td><td className="mono">{f.schema_name}</td><td>{f.field_type}</td><td>{f.is_mandatory ? 'Yes' : 'No'}</td></tr>
          ))}</tbody>
        </table>
      )}
    </Modal>
  );
}
