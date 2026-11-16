import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

export default function WebhooksApiSettings() {
  const [tab, setTab] = useState<'webhooks' | 'keys'>('webhooks');
  const [webhooks, setWebhooks] = useState<any[] | null>(null);
  const [availableEvents, setAvailableEvents] = useState<string[]>([]);
  const [keys, setKeys] = useState<any[] | null>(null);
  const [showWebhook, setShowWebhook] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [newSecret, setNewSecret] = useState<{ label: string; value: string } | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<any | null>(null);
  const [error, setError] = useState('');

  async function loadWebhooks() { const d = await api.get('/v1/webhooks'); setWebhooks(d.items); setAvailableEvents(d.availableEvents); }
  async function loadKeys() { setKeys((await api.get('/v1/api-keys')).items); }
  useEffect(() => { loadWebhooks().catch(e => setError(errMsg(e))); loadKeys().catch(() => {}); }, []);

  return (
    <div>
      <div className="page-header"><div><h1>Webhooks & API</h1><p>Automate other systems and integrate with the NexCRM API</p></div></div>
      {error && <Alert>{error}</Alert>}
      {newSecret && (
        <Alert kind="success">
          {newSecret.label}: <span className="mono">{newSecret.value}</span> — copy this now, it won't be shown again.
        </Alert>
      )}
      <div className="pill-nav">
        <div className={`pill ${tab === 'webhooks' ? 'active' : ''}`} onClick={() => setTab('webhooks')}>Webhooks</div>
        <div className={`pill ${tab === 'keys' ? 'active' : ''}`} onClick={() => setTab('keys')}>API Keys</div>
      </div>

      {tab === 'webhooks' && (
        <div className="card">
          <div className="card-header">Subscriptions <button className="btn btn-sm btn-primary" onClick={() => setShowWebhook(true)}>+ New Webhook</button></div>
          <div className="card-body">
            {webhooks === null ? <Loading /> : webhooks.length === 0 ? <p className="text-muted">No webhooks configured.</p> : (
              <table><thead><tr><th>URL</th><th>Events</th><th>Status</th><th></th></tr></thead>
                <tbody>{webhooks.map(w => (
                  <tr key={w.id}><td className="mono small">{w.url}</td>
                    <td>{w.events.map((e: string) => <span key={e} className="badge badge-primary" style={{ marginRight: 4 }}>{e}</span>)}</td>
                    <td><Badge kind={w.is_active ? 'success' : 'muted'}>{w.is_active ? 'Active' : 'Paused'}</Badge></td>
                    <td><button className="btn btn-sm" onClick={() => setDeliveriesFor(w)}>Deliveries</button></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'keys' && (
        <div className="card">
          <div className="card-header">API Keys <button className="btn btn-sm btn-primary" onClick={() => setShowKey(true)}>+ New Key</button></div>
          <div className="card-body">
            {keys === null ? <Loading /> : keys.length === 0 ? <p className="text-muted">No API keys yet.</p> : (
              <table><thead><tr><th>Name</th><th>Key ID</th><th>Scopes</th><th>Last used</th></tr></thead>
                <tbody>{keys.map(k => (
                  <tr key={k.id}><td>{k.name}</td><td className="mono small">{k.key_id}</td>
                    <td>{k.scopes.map((s: string) => <span key={s} className="badge badge-muted" style={{ marginRight: 4 }}>{s}</span>)}</td>
                    <td className="text-muted small">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {showWebhook && <NewWebhookModal availableEvents={availableEvents} onClose={() => setShowWebhook(false)}
        onDone={(secret) => { setShowWebhook(false); setNewSecret({ label: 'Webhook signing secret', value: secret }); loadWebhooks(); }} />}
      {showKey && <NewKeyModal onClose={() => setShowKey(false)}
        onDone={(secret) => { setShowKey(false); setNewSecret({ label: 'API key secret', value: secret }); loadKeys(); }} />}
      {deliveriesFor && <DeliveriesModal webhook={deliveriesFor} onClose={() => setDeliveriesFor(null)} />}
    </div>
  );
}

function DeliveriesModal({ webhook, onClose }: { webhook: any; onClose: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/v1/webhooks/${webhook.id}/deliveries`).then(d => setItems(d.items)).catch(e => setError(errMsg(e)));
  }, [webhook.id]);
  return (
    <Modal title="Recent Deliveries" onClose={onClose} width={720} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <p className="small text-muted mono">{webhook.url}</p>
      {error && <Alert>{error}</Alert>}
      {items === null ? <Loading /> : items.length === 0 ? <p className="text-muted">No deliveries recorded yet.</p> : (
        <table><thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Code</th><th>When</th></tr></thead>
          <tbody>{items.map(d => (
            <tr key={d.id}>
              <td className="small">{d.event}</td>
              <td><Badge kind={d.status === 'success' ? 'success' : d.status === 'failed' ? 'danger' : 'muted'}>{d.status}</Badge></td>
              <td>{d.attempts}</td>
              <td className="small">{d.last_response_code || (d.last_error ? '—' : '')}</td>
              <td className="text-muted small">{new Date(d.created_at).toLocaleString()}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Modal>
  );
}

function NewWebhookModal({ availableEvents, onClose, onDone }: { availableEvents: string[]; onClose: () => void; onDone: (secret: string) => void }) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['lead.created']);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function toggle(e: string) { setEvents(cur => cur.includes(e) ? cur.filter(x => x !== e) : [...cur, e]); }

  async function submit() {
    setBusy(true); setError('');
    try { const r = await api.post('/v1/webhooks', { url, events }); onDone(r.secret); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="New Webhook" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Create Webhook'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Endpoint URL"><input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-system.com/hooks/nexcrm" /></Field>
      <Field label="Events">
        <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
          {availableEvents.map(e => (
            <label key={e} className="checkbox-row badge badge-muted" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={events.includes(e)} onChange={() => toggle(e)} /> {e}
            </label>
          ))}
        </div>
      </Field>
    </Modal>
  );
}

function NewKeyModal({ onClose, onDone }: { onClose: () => void; onDone: (secret: string) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['leads:read', 'leads:write']);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const allScopes = ['leads:read', 'leads:write', 'leads:delete', 'activities:read', 'activities:write', 'opportunities:read', 'opportunities:write', 'opportunities:delete', 'tasks:read', 'tasks:write', 'tasks:delete', 'users:read', 'users:write', 'users:delete'];

  function toggle(s: string) { setScopes(cur => cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s]); }

  async function submit() {
    setBusy(true); setError('');
    try { const r = await api.post('/v1/api-keys', { name, scopes }); onDone(`${r.key_id} / ${r.secret}`); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="New API Key" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Create Key'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Marketing site integration" /></Field>
      <Field label="Scopes" hint="Delete scopes require settings-admin permission">
        <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
          {allScopes.map(s => (
            <label key={s} className="checkbox-row badge badge-muted" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} /> {s}
            </label>
          ))}
        </div>
      </Field>
    </Modal>
  );
}
