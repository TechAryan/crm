import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';
import { CreateFieldModal } from './EntityFieldsSettings';

export default function OpportunityTypesSettings() {
  const [types, setTypes] = useState<any[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editStages, setEditStages] = useState<any | null>(null);
  const [fieldsFor, setFieldsFor] = useState<any | null>(null);
  const [error, setError] = useState('');

  async function load() { try { setTypes((await api.get('/v1/opportunity-types')).items); } catch (e: any) { setError(errMsg(e)); } }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="page-header">
        <div><h1>Opportunity Types</h1><p>Each type is its own pipeline with its own stages and field schema — LSQ-style multiple opportunity types per account</p></div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Create Type</button>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        {types === null ? <Loading /> : (
          <table>
            <thead><tr><th>Type</th><th>Stages</th><th></th></tr></thead>
            <tbody>
              {types.map(t => (
                <tr key={t.id} style={{ cursor: 'default' }}>
                  <td style={{ fontWeight: 600 }}>{t.name}</td>
                  <td>{(t.stages || []).map((s: any) => (
                    <Badge key={s.name} kind={s.status === 'Won' ? 'success' : s.status === 'Lost' ? 'danger' : 'primary'}>{s.name}</Badge>
                  )).reduce((acc: any[], el: any, i: number) => [...acc, i > 0 ? ' ' : null, el], [])}</td>
                  <td className="flex gap-8">
                    <button className="btn btn-sm" onClick={() => setEditStages(t)}>Edit Stages</button>
                    <button className="btn btn-sm" onClick={() => setFieldsFor(t)}>Fields</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showCreate && <CreateOppTypeModal onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />}
      {editStages && <StagesModal type={editStages} onClose={() => setEditStages(null)} onDone={() => { setEditStages(null); load(); }} />}
      {fieldsFor && <OppTypeFieldsModal type={fieldsFor} onClose={() => setFieldsFor(null)} />}
    </div>
  );
}

function CreateOppTypeModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError('');
    try { await api.post('/v1/opportunity-types', { name }); onDone(); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Create Opportunity Type" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name} onClick={submit}>{busy ? 'Saving…' : 'Create'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Type name" hint="e.g. Online Course, Offline Batch, Enterprise Deal — starts with default stages, edit them after creating">
        <input value={name} onChange={e => setName(e.target.value)} />
      </Field>
    </Modal>
  );
}

function StagesModal({ type, onClose, onDone }: { type: any; onClose: () => void; onDone: () => void }) {
  const [stages, setStages] = useState<any[]>(type.stages || []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function setStage(i: number, k: string, v: string) { setStages(s => s.map((x, idx) => idx === i ? { ...x, [k]: v } : x)); }
  function addStage() { setStages(s => [...s, { name: '', status: 'Open' }]); }
  function removeStage(i: number) { setStages(s => s.filter((_, idx) => idx !== i)); }

  async function save() {
    setBusy(true); setError('');
    try { await api.patch(`/v1/opportunity-types/${type.id}`, { stages: stages.filter(s => s.name) }); onDone(); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Stages: ${type.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save Stages'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <p className="small text-muted">Statuses are fixed (Open / Won / Lost); stages nest within statuses.</p>
      {stages.map((s, i) => (
        <div className="flex gap-8 mt-8" key={i}>
          <input value={s.name} onChange={e => setStage(i, 'name', e.target.value)} placeholder="Stage name" style={{ flex: 2 }} />
          <select value={s.status} onChange={e => setStage(i, 'status', e.target.value)} style={{ flex: 1 }}>
            <option>Open</option><option>Won</option><option>Lost</option>
          </select>
          <button className="btn btn-sm" onClick={() => removeStage(i)}>✕</button>
        </div>
      ))}
      <button className="btn btn-sm mt-8" onClick={addStage}>+ Add stage</button>
    </Modal>
  );
}

function OppTypeFieldsModal({ type, onClose }: { type: any; onClose: () => void }) {
  const [fields, setFields] = useState<any[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  async function load() { setFields((await api.get(`/v1/opportunity-types/${type.id}/fields`)).items); }
  useEffect(() => { load(); }, [type.id]);

  return (
    <>
      <Modal title={`Fields: ${type.name}`} onClose={onClose} footer={<>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Create Field</button>
        <button className="btn" onClick={onClose}>Close</button>
      </>}>
        {fields === null ? <Loading /> : fields.length === 0 ? <p className="text-muted">No custom fields on this type yet.</p> : (
          <table>
            <thead><tr><th>Label</th><th>Schema</th><th>Type</th><th>Mandatory</th><th>Unique</th></tr></thead>
            <tbody>{fields.map(f => (
              <tr key={f.id} style={{ cursor: 'default' }}>
                <td>{f.label}</td><td className="mono">{f.schema_name}</td><td>{f.field_type}</td>
                <td>{f.is_mandatory ? 'Yes' : 'No'}</td><td>{f.is_unique ? <Badge kind="warning">Unique</Badge> : 'No'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Modal>
      {showCreate && (
        <CreateFieldModal entity={`opportunity_type:${type.id}`} apiPath={`/v1/opportunity-types/${type.id}/fields`}
          onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />
      )}
    </>
  );
}
