import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, errMsg } from '../../ui';

/** Manager-hierarchy behavior: whether "team" scoped permissions see the whole reporting
 *  subtree, and whether owner changes cascade down to linked opportunities/tasks. */
export default function OrganizationSettings() {
  const [settings, setSettings] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    api.get('/v1/settings/tenant').then(setSettings).catch(e => setError(errMsg(e)));
  }
  useEffect(() => { load(); }, []);

  async function save(patch: any) {
    setBusy(true); setSaved(false); setError('');
    try { const s = await api.patch('/v1/settings/tenant', patch); setSettings(s); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  if (!settings) return <div className="loading">Loading…</div>;

  return (
    <div>
      <div className="page-header">
        <div><h1>Organization</h1><p>Manager hierarchy, record visibility, and owner-change cascades</p></div>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="card">
        <div className="card-header">Hierarchy Visibility {saved && <Badge kind="success">Saved</Badge>}</div>
        <div className="card-body">
          <label className="checkbox-row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={!!settings.hierarchyVisibility} disabled={busy}
              onChange={e => save({ hierarchyVisibility: e.target.checked })} />
            {' '}Users with "Team" scoped view/edit/delete permissions can see records owned by anyone below them
            in the manager hierarchy, not just their own.
          </label>
          <p className="small text-muted mt-8">
            When turned off, "Team" scope behaves the same as "Own" — each user only sees their own records,
            regardless of who reports to them. The System user can always see every record, either way.
            Set each user's manager from the Users page to build the hierarchy.
          </p>
        </div>
      </div>
      <div className="card">
        <div className="card-header">Owner Change Cascades</div>
        <div className="card-body">
          <label className="checkbox-row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={!!settings.cascadeOwnerToOpportunity} disabled={busy}
              onChange={e => save({ cascadeOwnerToOpportunity: e.target.checked })} />
            {' '}When a lead's owner changes, also reassign its linked opportunities to the new owner.
          </label>
          <label className="checkbox-row mt-8" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={!!settings.cascadeOwnerToTask} disabled={busy}
              onChange={e => save({ cascadeOwnerToTask: e.target.checked })} />
            {' '}When a lead's owner changes, also reassign its open tasks to the new owner.
          </label>
        </div>
      </div>
    </div>
  );
}
