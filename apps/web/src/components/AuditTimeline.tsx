import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Alert, Loading, errMsg } from '../ui';

const ACTION_LABELS: Record<string, string> = {
  'lead.created': 'Lead created', 'lead.updated': 'Lead updated', 'lead.stage_changed': 'Stage changed',
  'lead.owner_changed': 'Owner changed', 'lead.deleted': 'Lead deleted', 'lead.merged': 'Lead merged',
  'opportunity.created': 'Opportunity created', 'opportunity.updated': 'Opportunity updated', 'opportunity.deleted': 'Opportunity deleted',
  'activity.updated': 'Activity edited', 'activity.deleted': 'Activity deleted',
};

const SKIP_DIFF_KEYS = new Set(['updated_at', 'updated_by', 'created_at']);

function diffSummary(before: any, after: any): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (SKIP_DIFF_KEYS.has(k)) continue;
    const a = JSON.stringify(before[k]), b = JSON.stringify(after[k]);
    if (a === b) continue;
    if (k === 'fields' && typeof before.fields === 'object' && typeof after.fields === 'object') {
      const fkeys = new Set([...Object.keys(before.fields || {}), ...Object.keys(after.fields || {})]);
      for (const fk of fkeys) {
        const fa = before.fields?.[fk], fb = after.fields?.[fk];
        if (JSON.stringify(fa) !== JSON.stringify(fb)) out.push(`${fk.replace(/^mx_/, '')}: ${fa ?? '—'} → ${fb ?? '—'}`);
      }
      continue;
    }
    out.push(`${k}: ${before[k] ?? '—'} → ${after[k] ?? '—'}`);
  }
  return out;
}

interface Props { leadId?: string; opportunityId?: string }

/** Renders the field-level audit trail for a lead or opportunity (plus its linked activities)
 *  as a vertical timeline stepper: who changed what, and when. */
export default function AuditTimeline({ leadId, opportunityId }: Props) {
  const [items, setItems] = useState<any[] | null>(null);
  const [details, setDetails] = useState<Record<string, any>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (leadId) params.set('leadId', leadId);
    if (opportunityId) params.set('opportunityId', opportunityId);
    params.set('limit', '100');
    api.get(`/v1/audit?${params.toString()}`).then(d => setItems(d.items)).catch(e => setError(errMsg(e)));
  }, [leadId, opportunityId]);

  async function expand(id: string) {
    if (details[id]) { setDetails(d => { const n = { ...d }; delete n[id]; return n; }); return; }
    const qs = new URLSearchParams(); if (leadId) qs.set('leadId', leadId); if (opportunityId) qs.set('opportunityId', opportunityId);
    try { const row = await api.get(`/v1/audit/${id}?${qs.toString()}`); setDetails(d => ({ ...d, [id]: row })); }
    catch (e: any) { setError(errMsg(e)); }
  }

  if (error) return <Alert>{error}</Alert>;
  if (items === null) return <Loading />;
  if (items.length === 0) return <p className="text-muted">No changes recorded yet.</p>;

  return (
    <div className="audit-timeline">
      {items.map(a => {
        const actorName = a.actor_type !== 'user' ? a.actor_type : ([a.actor_first, a.actor_last].filter(Boolean).join(' ') || a.actor_email || 'User');
        const label = ACTION_LABELS[a.action] || a.action;
        const detail = details[a.id];
        const diffs = detail ? diffSummary(detail.before, detail.after) : [];
        return (
          <div className="timeline-item" key={a.id}>
            <div className="timeline-dot" />
            <div className="timeline-body">
              <div>
                <strong>{label}</strong>
                <span className="text-muted small"> · {a.entity}{a.entity !== (leadId ? 'lead' : 'opportunity') ? ` (linked)` : ''}</span>
                {' '}
                <button className="btn btn-sm" style={{ padding: '1px 8px' }} onClick={() => expand(a.id)}>{detail ? 'Hide' : 'What changed?'}</button>
              </div>
              <div className="small text-muted">{actorName} · {new Date(a.created_at).toLocaleString()}</div>
              {detail && (
                diffs.length ? (
                  <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {diffs.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                ) : <div className="small text-muted mt-8">No field-level changes recorded for this entry.</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
