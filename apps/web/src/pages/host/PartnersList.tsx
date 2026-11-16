import React, { useEffect, useState } from 'react';
import { hostApi } from '../../api';
import { Alert, Field, Loading, Modal, errMsg } from '../../ui';

export default function PartnersList() {
  const [partners, setPartners] = useState<any[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');

  async function load() { try { setPartners((await hostApi.get('/host/api/partners')).items); } catch (e: any) { setError(errMsg(e)); } }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="page-header">
        <div><h1>Partners</h1><p>Reseller accounts that white-label and manage their own tenants</p></div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Partner</button>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        {partners === null ? <Loading /> : partners.length === 0 ? <div className="card-body text-muted">No partners yet.</div> : (
          <table><thead><tr><th>Name</th><th>Contact Email</th></tr></thead>
            <tbody>{partners.map(p => <tr key={p.id}><td>{p.name}</td><td>{p.contact_email || '—'}</td></tr>)}</tbody>
          </table>
        )}
      </div>
      {showCreate && <CreatePartnerModal onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreatePartnerModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError('');
    try { await hostApi.post('/host/api/partners', { name, contactEmail }); onDone(); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="New Partner" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Create Partner'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Partner name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Contact email"><input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} /></Field>
    </Modal>
  );
}
