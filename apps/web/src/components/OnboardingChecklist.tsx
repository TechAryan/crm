import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Badge } from '../ui';

/**
 * First-run setup checklist.
 *
 * Auto-hides once every required step is done, so it never becomes permanent furniture for
 * established tenants. A user can also dismiss it early (remembered locally) — a checklist you
 * can't get rid of is an irritation, and irritation is what makes people ignore guidance.
 */
export function OnboardingChecklist() {
  const nav = useNavigate();
  const [data, setData] = useState<any>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('nx_onboarding_dismissed') === '1');
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (dismissed) return;
    api.get('/v1/onboarding').then(setData).catch(() => setData(null));
  }, [dismissed]);

  if (dismissed || !data) return null;
  // Nothing left to guide — get out of the way permanently.
  if (data.isReadyToUse && data.progress.percent === 100) return null;

  const dismiss = () => { localStorage.setItem('nx_onboarding_dismissed', '1'); setDismissed(true); };

  return (
    <div className="card" style={{ marginBottom: 16, borderColor: 'var(--primary)' }}>
      <div className="card-header">
        <span>
          Finish setting up
          {' '}
          <Badge kind={data.isReadyToUse ? 'success' : 'primary'}>
            {data.progress.requiredDone}/{data.progress.requiredTotal} essentials
          </Badge>
          {data.isReadyToUse && <span className="text-muted small"> — you're ready to use the CRM</span>}
        </span>
        <span className="flex gap-8">
          <button className="btn btn-sm" onClick={() => setExpanded(e => !e)}>{expanded ? 'Hide' : 'Show'}</button>
          <button className="btn btn-sm" onClick={dismiss}>Dismiss</button>
        </span>
      </div>

      {expanded && (
        <div className="card-body">
          {/* Progress bar against required steps only — optional ones shouldn't make it look unfinished. */}
          <div style={{ background: 'var(--bg)', borderRadius: 4, height: 8, marginBottom: 14 }}>
            <div style={{
              width: `${data.progress.requiredPercent}%`, height: '100%', borderRadius: 4,
              background: data.isReadyToUse ? 'var(--success)' : 'var(--primary)', transition: 'width .3s',
            }} />
          </div>

          {data.nextAction && (
            <div className="flex-between" style={{
              padding: '10px 12px', background: 'var(--primary-soft)', borderRadius: 6, marginBottom: 12,
            }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Next: {data.nextAction.title}</div>
                <div className="text-muted small">{data.nextAction.description}</div>
              </div>
              <button className="btn btn-sm btn-primary" onClick={() => nav(data.nextAction.route)}>Do this</button>
            </div>
          )}

          {data.steps.map((s: any) => (
            <div key={s.key} className="flex-between mt-8" style={{ opacity: s.done ? 0.55 : 1 }}>
              <div className="flex gap-8" style={{ alignItems: 'flex-start' }}>
                <span style={{ color: s.done ? 'var(--success)' : 'var(--text-muted)', fontWeight: 700, width: 16 }}>
                  {s.done ? '✓' : '○'}
                </span>
                <div>
                  <div className="small" style={{ fontWeight: 600, textDecoration: s.done ? 'line-through' : 'none' }}>
                    {s.title}
                    {!s.required && <span className="text-muted" style={{ fontWeight: 400 }}> · optional</span>}
                  </div>
                  {!s.done && <div className="text-muted small">{s.description}</div>}
                  {s.detail && <div className="text-muted" style={{ fontSize: 11 }}>{s.detail}</div>}
                </div>
              </div>
              {!s.done && <button className="btn btn-sm" onClick={() => nav(s.route)}>Open</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
