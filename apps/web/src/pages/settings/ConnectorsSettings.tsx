import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000';

export default function ConnectorsSettings() {
  const [items, setItems] = useState<any[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');

  async function load() { try { setItems((await api.get('/v1/connectors')).items); } catch (e: any) { setError(errMsg(e)); } }
  useEffect(() => { load(); }, []);

  function inboundUrl(c: any) {
    if (c.type === 'webform') return `${API_URL}/capture/v1/forms/${c.public_token}`;
    if (c.type === 'meta') return `${API_URL}/capture/v1/meta/${c.public_token}`;
    if (c.type === 'whatsapp') return `${API_URL}/capture/v1/whatsapp/${c.public_token}`;
    return '';
  }

  return (
    <div>
      <div className="page-header">
        <div><h1>Connectors</h1><p>Automatically capture leads from WhatsApp, Meta, and your website</p></div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Connector</button>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        {items === null ? <Loading /> : items.length === 0 ? <div className="card-body text-muted">No connectors configured yet.</div> : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Inbound URL</th><th>Status</th></tr></thead>
            <tbody>
              {items.map(c => (
                <tr key={c.id} style={{ cursor: 'default' }}>
                  <td>{c.name}</td><td><Badge kind="primary">{c.type}</Badge></td>
                  <td className="mono small">
                    {inboundUrl(c)}
                    {c.type === 'webform' && (
                      <div className="mt-8">
                        <a href={`${inboundUrl(c)}/page`} target="_blank" rel="noreferrer" className="btn btn-sm">Open hosted form ↗</a>
                        <span className="text-muted small" style={{ marginLeft: 8 }}>Share this link to collect leads without a website</span>
                      </div>
                    )}
                  </td>
                  <td><Badge kind={c.is_active ? 'success' : 'muted'}>{c.is_active ? 'Active' : 'Paused'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card"><div className="card-body text-muted small">
        <strong>Website forms:</strong> point your HTML form's action at the inbound URL, with a field map matching your form's input names.<br />
        <strong>Meta:</strong> use the inbound URL as your Facebook Lead Ads webhook callback URL during app review.<br />
        <strong>WhatsApp:</strong> use the inbound URL as your WhatsApp Cloud API webhook callback URL.
      </div></div>
      {showCreate && <CreateConnectorModal onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateConnectorModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState('webform');
  const [name, setName] = useState('');
  const [fieldMap, setFieldMap] = useState('name:firstName, email:email, phone:phone');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError('');
    try {
      const config: any = {};
      if (type === 'webform') {
        config.fieldMap = Object.fromEntries(fieldMap.split(',').map(p => p.split(':').map(s => s.trim())));
      }
      await api.post('/v1/connectors', { type, name, config });
      onDone();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="New Connector" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Create Connector'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Type">
        <select value={type} onChange={e => setType(e.target.value)}>
          <option value="webform">Website Form</option>
          <option value="meta">Meta / Facebook Lead Ads</option>
          <option value="whatsapp">WhatsApp Business</option>
        </select>
      </Field>
      <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Homepage Contact Form" /></Field>
      {type === 'webform' && (
        <Field label="Field mapping" hint="form field : lead field, comma separated. Use fields.mx_xxx for custom fields.">
          <input value={fieldMap} onChange={e => setFieldMap(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}
