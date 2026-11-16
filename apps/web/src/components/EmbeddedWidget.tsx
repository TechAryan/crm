import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Alert, Loading } from '../ui';

/**
 * Renders a tenant-defined embedded widget.
 *
 * iframe kind — the external page is loaded in a SANDBOXED iframe. The sandbox deliberately
 * omits `allow-same-origin`, so the embedded page gets an opaque origin and cannot reach our
 * localStorage (where the session JWT lives), our cookies or our DOM. That's the whole reason
 * this is safe to offer: a customer can embed anything, including a page we've never seen,
 * without it being able to touch the CRM session.
 *
 * html kind — markup was sanitized server-side on save (script tags, event handlers and
 * javascript:/data: URLs stripped). We render it inline for layout convenience only; anything
 * that needs to execute should be an iframe widget instead.
 */
export function EmbeddedWidget({ widgetId, entity, recordId }: {
  widgetId: string; entity?: 'lead' | 'opportunity'; recordId?: string;
}) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null); setError('');
    const q = new URLSearchParams();
    if (recordId) q.set('recordId', recordId);
    if (entity) q.set('entity', entity);
    api.get(`/v1/widgets/${widgetId}/resolve${q.toString() ? `?${q}` : ''}`)
      .then(setData)
      .catch(e => setError(e?.message || 'Could not load this widget'));
  }, [widgetId, entity, recordId]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;

  if (data.kind === 'html') {
    return (
      <div className="card">
        <div className="card-body">
          {/* Server-sanitized on save; no scripts can run from this markup. */}
          <div dangerouslySetInnerHTML={{ __html: data.html || '' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <iframe
        src={data.url}
        title={data.name}
        style={{ width: '100%', height: data.height || 520, border: 0, borderRadius: 'var(--radius)', display: 'block' }}
        // No allow-same-origin: the embedded page cannot read our storage or DOM.
        sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  );
}

/** Lists widgets for a placement and renders them (used on record pages and the dashboard). */
export function WidgetsForPlacement({ placement, entity, recordId }: {
  placement: string; entity?: 'lead' | 'opportunity'; recordId?: string;
}) {
  const [widgets, setWidgets] = useState<any[]>([]);
  useEffect(() => {
    api.get(`/v1/widgets?placement=${placement}`)
      .then(d => setWidgets(d.items || []))
      .catch(() => setWidgets([]));   // feature locked or none configured — render nothing
  }, [placement]);

  if (!widgets.length) return null;
  return (
    <>
      {widgets.map(w => (
        <div key={w.id} className="mt-16">
          <div className="small text-muted" style={{ marginBottom: 6 }}>{w.name}</div>
          <EmbeddedWidget widgetId={w.id} entity={entity} recordId={recordId} />
        </div>
      ))}
    </>
  );
}
