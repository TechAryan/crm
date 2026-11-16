import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

export default function AuditLogSettings() {
  const [items, setItems] = useState<any[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [detail, setDetail] = useState<any | null>(null);
  const [error, setError] = useState('');
  const limit = 50;

  async function load(p = page) {
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(limit) });
      if (entity) params.set('entity', entity);
      if (action) params.set('action', action);
      const d = await api.get(`/v1/audit?${params.toString()}`);
      setItems(d.items); setTotal(d.total); setPage(p); setError('');
    } catch (e: any) { setError(errMsg(e)); }
  }
  useEffect(() => { load(1); }, []);

  const actorName = (r: any) => {
    if (r.actor_type !== 'user') return r.actor_type;
    return [r.actor_first, r.actor_last].filter(Boolean).join(' ') || r.actor_email || 'User';
  };
  const pages = Math.ceil(total / limit);

  return (
    <div>
      <div className="page-header"><div><h1>Audit Log</h1><p>{total} recorded events — who changed what, and when</p></div></div>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-8" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={entity} onChange={e => setEntity(e.target.value)}>
          <option value="">All entities</option>
          <option value="lead">Lead</option>
          <option value="opportunity">Opportunity</option>
          <option value="activity">Activity</option>
          <option value="user">User</option>
        </select>
        <input placeholder="Action starts with… (e.g. lead.)" value={action} onChange={e => setAction(e.target.value)} style={{ width: 220 }} />
        <button className="btn" onClick={() => load(1)}>Filter</button>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        {items === null ? <Loading /> : items.length === 0 ? <p className="text-muted" style={{ padding: 16 }}>No audit events found.</p> : (
          <table>
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th></th></tr></thead>
            <tbody>{items.map(r => (
              <tr key={r.id}>
                <td className="small text-muted">{new Date(r.created_at).toLocaleString()}</td>
                <td className="small">{actorName(r)} <Badge kind="muted">{r.actor_type}</Badge></td>
                <td className="small mono">{r.action}</td>
                <td className="small">{r.entity}</td>
                <td><button className="btn btn-sm" onClick={() => setDetail(r)}>Details</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {pages > 1 && (
        <div className="flex gap-8" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => load(page - 1)}>Prev</button>
          <span className="small text-muted">Page {page} of {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => load(page + 1)}>Next</button>
        </div>
      )}
      {detail && <AuditDetailModal id={detail.id} onClose={() => setDetail(null)} />}
    </div>
  );
}

function AuditDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [row, setRow] = useState<any | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/v1/audit/${id}`).then(setRow).catch(e => setError(errMsg(e))); }, [id]);
  return (
    <Modal title="Audit Entry" onClose={onClose} width={720} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {error && <Alert>{error}</Alert>}
      {!row ? <Loading /> : (
        <div>
          <p className="small"><strong>{row.action}</strong> on {row.entity} <span className="mono">{row.entity_id}</span></p>
          <p className="small text-muted">{new Date(row.created_at).toLocaleString()} · {row.actor_type}{row.ip ? ` · ${row.ip}` : ''}</p>
          <div className="form-row" style={{ marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label>Before</label>
              <pre className="small mono" style={{ background: 'var(--bg-muted,#f6f8fa)', padding: 8, overflow: 'auto', maxHeight: 300 }}>{row.before ? JSON.stringify(row.before, null, 2) : '—'}</pre>
            </div>
            <div style={{ flex: 1 }}>
              <label>After</label>
              <pre className="small mono" style={{ background: 'var(--bg-muted,#f6f8fa)', padding: 8, overflow: 'auto', maxHeight: 300 }}>{row.after ? JSON.stringify(row.after, null, 2) : '—'}</pre>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
