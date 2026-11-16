import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Alert } from '../ui';

/**
 * Renders the tenant's configured custom action buttons for a record.
 *
 * Two modes per action:
 *  - open_url: the merged URL is returned and opened in a new tab (client-side navigation only).
 *  - http: the server makes the call (so secrets stay server-side and CORS is irrelevant)
 *    and we surface the outcome.
 */
export function CustomActionButtons({ entity, recordId, onDone }: {
  entity: 'lead' | 'opportunity' | 'activity'; recordId: string; onDone?: () => void;
}) {
  const [actions, setActions] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    // 402 = feature not enabled on plan; just render nothing in that case.
    api.get(`/v1/custom-actions?entity=${entity}`)
      .then(d => setActions(d.items || [])).catch(() => setActions([]));
  }, [entity]);

  async function run(a: any) {
    if (a.confirm_text && !confirm(a.confirm_text)) return;
    setBusyId(a.id); setMsg(null);
    try {
      const r = await api.post(`/v1/custom-actions/${a.id}/execute`, { recordId });
      if (r.mode === 'open_url' && r.url) {
        window.open(r.url, '_blank', 'noopener,noreferrer');
      } else {
        setMsg({ kind: 'success', text: r.message || 'Action completed' });
        onDone?.();
      }
    } catch (e: any) {
      setMsg({ kind: 'danger', text: e?.message || 'Action failed' });
    } finally {
      setBusyId(null);
      setTimeout(() => setMsg(null), 6000);
    }
  }

  if (!actions.length) return null;

  return (
    <>
      {actions.map(a => (
        <button key={a.id} className="btn" disabled={busyId === a.id} onClick={() => run(a)}>
          {busyId === a.id ? '…' : a.name}
        </button>
      ))}
      {msg && (
        <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 300, maxWidth: 360 }}>
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
    </>
  );
}
