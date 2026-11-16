import React, { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Feature entitlement helpers.
 *
 * Paid features render as VISIBLE BUT LOCKED rather than hidden — a locked panel with a clear
 * label creates demand, whereas a hidden feature is invisible. Enforcement is always
 * server-side; this component is presentation only.
 */

let cached: { enabled: Record<string, boolean>; items: any[] } | null = null;

export function useFeatures() {
  const [state, setState] = useState<{ enabled: Record<string, boolean>; items: any[] } | null>(cached);
  useEffect(() => {
    if (cached) return;
    api.get('/v1/features')
      .then(d => { cached = { enabled: d.enabled || {}, items: d.items || [] }; setState(cached); })
      .catch(() => { cached = { enabled: {}, items: [] }; setState(cached); });
  }, []);
  return { enabled: state?.enabled || {}, items: state?.items || [], loading: !state };
}

export function FeatureLock({ feature }: { feature: string }) {
  const { items } = useFeatures();
  const def = items.find(i => i.key === feature);
  return (
    <div className="card" style={{ borderStyle: 'dashed' }}>
      <div className="card-body" style={{ textAlign: 'center', padding: '32px 20px' }}>
        <div style={{ fontSize: 22, marginBottom: 8 }}>🔒</div>
        <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>{def?.label || feature} is not enabled on your plan</h3>
        <p className="text-muted small" style={{ margin: '0 auto', maxWidth: 460 }}>
          {def?.description || 'This is a paid add-on.'}
          {' '}Contact your account manager to unlock it for your account.
        </p>
      </div>
    </div>
  );
}
