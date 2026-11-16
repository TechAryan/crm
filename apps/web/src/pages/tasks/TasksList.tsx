import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Badge, EmptyState, Loading, errMsg, Alert } from '../../ui';

export default function TasksList() {
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  async function load() { try { setItems((await api.get('/v1/tasks')).items); } catch (e: any) { setError(errMsg(e)); } }
  useEffect(() => { load(); }, []);

  async function markDone(id: string) {
    try { await api.patch(`/v1/tasks/${id}`, { status: 'done' }); load(); } catch (e: any) { setError(errMsg(e)); }
  }

  return (
    <div>
      <div className="page-header"><div><h1>Tasks</h1><p>Your to-dos and appointments</p></div></div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        {items === null ? <Loading /> : items.length === 0 ? (
          <EmptyState title="No tasks" subtitle="Tasks you create on leads will show up here." />
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Due</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {items.map(t => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="text-muted">{t.kind}</td>
                  <td className="text-muted">{t.due_at ? new Date(t.due_at).toLocaleString() : '—'}</td>
                  <td><Badge kind={t.status === 'done' ? 'success' : t.status === 'cancelled' ? 'muted' : 'warning'}>{t.status}</Badge></td>
                  <td>{t.status !== 'done' && <button className="btn btn-sm" onClick={() => markDone(t.id)}>Mark done</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
