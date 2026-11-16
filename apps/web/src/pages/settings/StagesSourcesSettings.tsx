import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

export default function StagesSourcesSettings() {
  const [stages, setStages] = useState<any[] | null>(null);
  const [sources, setSources] = useState<any[] | null>(null);
  const [showStage, setShowStage] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const [s, so] = await Promise.all([api.get('/v1/stages'), api.get('/v1/sources')]);
      setStages(s.items); setSources(so.items);
    } catch (e: any) { setError(errMsg(e)); }
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="page-header"><div><h1>Lead Stages & Sources</h1><p>Define your pipeline stages and where leads come from</p></div></div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        <div className="card-header">Lead Stages <button className="btn btn-sm btn-primary" onClick={() => setShowStage(true)}>+ Add Stage</button></div>
        {stages === null ? <Loading /> : (
          <table>
            <thead><tr><th>Order</th><th>Name</th><th>Class</th><th>Default</th></tr></thead>
            <tbody>
              {stages.sort((a, b) => a.sort_order - b.sort_order).map(s => (
                <tr key={s.id} style={{ cursor: 'default' }}>
                  <td>{s.sort_order}</td><td>{s.name}</td>
                  <td><Badge kind={s.is_active_stage ? 'success' : 'muted'}>{s.is_active_stage ? 'Active' : 'Inactive'}</Badge></td>
                  <td>{s.is_default ? 'Yes' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <div className="card-header">Lead Sources <button className="btn btn-sm btn-primary" onClick={() => setShowSource(true)}>+ Add Source</button></div>
        <div className="card-body">
          {sources === null ? <Loading /> : (
            <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
              {sources.map(s => <span key={s.id} className="badge badge-primary">{s.name}</span>)}
            </div>
          )}
        </div>
      </div>
      {showStage && <AddStageModal onClose={() => setShowStage(false)} onDone={() => { setShowStage(false); load(); }} />}
      {showSource && <AddSourceModal onClose={() => setShowSource(false)} onDone={() => { setShowSource(false); load(); }} />}
    </div>
  );
}

function AddStageModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [isActiveStage, setIsActiveStage] = useState(true);
  const [sortOrder, setSortOrder] = useState(100);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError('');
    try { await api.post('/v1/stages', { name, isActiveStage, sortOrder }); onDone(); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Add Stage" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name} onClick={submit}>{busy ? 'Saving…' : 'Add Stage'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Stage name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Sort order"><input type="number" value={sortOrder} onChange={e => setSortOrder(Number(e.target.value))} /></Field>
      <div className="checkbox-row"><input type="checkbox" checked={isActiveStage} onChange={e => setIsActiveStage(e.target.checked)} /> Active/qualified stage (unchecked = closed, e.g. Lost/Invalid)</div>
    </Modal>
  );
}

function AddSourceModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError('');
    try { await api.post('/v1/sources', { name }); onDone(); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Add Source" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name} onClick={submit}>{busy ? 'Saving…' : 'Add Source'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Source name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
    </Modal>
  );
}
