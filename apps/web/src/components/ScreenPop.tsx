import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getToken } from '../api';
import { Badge, Modal } from '../ui';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000';

/**
 * Telephony screen-pop listener.
 *
 * Mounted once inside the authenticated shell. Opens an SSE connection to /v1/events/stream and
 * reacts to `screenpop` events addressed to THIS user — either navigating to the matching record
 * or showing a call card.
 *
 * EventSource can't send an Authorization header, so the token is passed as a query param on
 * this one endpoint. That's a deliberate, contained trade-off: the stream is read-only, the token
 * is already in the browser, and the alternative (a cookie) would need CSRF handling. If you
 * later put this behind a CDN, make sure this path isn't logged with query strings.
 */
export function ScreenPop() {
  const nav = useNavigate();
  const [pop, setPop] = useState<any>(null);
  const [enabled, setEnabled] = useState(() => localStorage.getItem('nx_screenpop') !== 'off');
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) { esRef.current?.close(); esRef.current = null; return; }
    const token = getToken();
    if (!token) return;

    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (closed) return;
      const es = new EventSource(`${API_URL}/v1/events/stream?token=${encodeURIComponent(token!)}`);
      esRef.current = es;

      es.addEventListener('screenpop', (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.eventId) api.post(`/v1/events/ack/${data.eventId}`).catch(() => {});
          // Replayed events (from a reconnect) shouldn't yank the user's screen around.
          if (data.mode === 'navigate' && data.navigateTo && !data.replayed) nav(data.navigateTo);
          else setPop(data);
        } catch { /* ignore malformed frame */ }
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        // EventSource auto-reconnects, but only for transient errors; reconnect explicitly
        // so an auth/network failure doesn't leave the agent silently disconnected.
        if (!closed && !retry) retry = setTimeout(() => { retry = null; connect(); }, 5000);
      };
    }
    connect();

    return () => { closed = true; if (retry) clearTimeout(retry); esRef.current?.close(); esRef.current = null; };
  }, [enabled, nav]);

  // Expose a per-user opt-out; some users share a desk or don't take calls.
  useEffect(() => {
    (window as any).__nxToggleScreenPop = () => {
      setEnabled(e => { const n = !e; localStorage.setItem('nx_screenpop', n ? 'on' : 'off'); return n; });
    };
  }, []);

  if (!pop) return null;

  const name = pop.lead
    ? `${pop.lead.first_name || ''} ${pop.lead.last_name || ''}`.trim() || pop.lead.email || pop.lead.phone
    : null;

  return (
    <Modal
      title={pop.direction === 'outbound' ? 'Outbound call' : 'Incoming call'}
      onClose={() => setPop(null)}
      width={520}
      footer={<>
        <button className="btn" onClick={() => setPop(null)}>Dismiss</button>
        {pop.lead && (
          <button className="btn btn-primary" onClick={() => { nav(`/leads/${pop.lead.id}`); setPop(null); }}>
            Open lead
          </button>
        )}
      </>}
    >
      <div className="flex gap-8" style={{ alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 20 }}>📞</span>
        <strong style={{ fontSize: 16 }}>{pop.phone || '—'}</strong>
        {pop.matched ? <Badge kind="success">Matched</Badge> : <Badge kind="warning">Unknown caller</Badge>}
      </div>

      {pop.ambiguous && (
        <div className="mt-8">
          <p className="small text-muted">
            More than one lead has this number — pick the right one rather than guessing:
          </p>
          {(pop.candidates || []).map((c: any) => (
            <button key={c.id} className="btn btn-sm mt-8" style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={() => { nav(`/leads/${c.id}`); setPop(null); }}>
              {c.name} — {c.phone || c.email}
            </button>
          ))}
        </div>
      )}

      {pop.lead && (
        <>
          <table>
            <tbody>
              {(pop.popupFields || []).map((f: string) => {
                const raw = f === 'owner' ? pop.lead.owner_id
                  : f === 'stage' ? pop.lead.stage_id
                  : (pop.lead as any)[f] ?? pop.lead.fields?.[f];
                const label = f.replace(/^mx_/, '').replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
                return (
                  <tr key={f} style={{ cursor: 'default' }}>
                    <td className="text-muted" style={{ width: 160 }}>{label}</td>
                    <td>{raw === null || raw === undefined || raw === '' ? '—' : String(raw)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {(pop.opportunities || []).length > 0 && (
            <div className="mt-16">
              <div className="small text-muted" style={{ marginBottom: 6 }}>Opportunities on this lead</div>
              {pop.opportunities.map((o: any) => (
                <button key={o.id} className="btn btn-sm mt-8" style={{ width: '100%', justifyContent: 'space-between' }}
                  onClick={() => { nav(`/opportunities/${o.id}`); setPop(null); }}>
                  <span>{o.name}</span>
                  <span className="text-muted">{o.stage} · {o.currency || ''} {Number(o.amount || 0).toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {!pop.matched && !pop.ambiguous && (
        <p className="text-muted small">
          No lead matches this number. You can create one from the Leads page after the call.
        </p>
      )}
    </Modal>
  );
}
