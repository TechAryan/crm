import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, errMsg } from '../../ui';

/** Controls the "Lead Properties" summary box on the lead detail page (which fields show, and
 *  in what order), plus what clicking a phone number does. Phone / Additional Phone / Email are
 *  always shown there regardless of this layout — see the note below. */
export default function LeadPropertiesSettings() {
  const [settings, setSettings] = useState<any>(null);
  const [fields, setFields] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    Promise.all([api.get('/v1/settings/tenant'), api.get('/v1/fields/lead')])
      .then(([s, f]) => { setSettings(s); setFields(f.items); })
      .catch(e => setError(errMsg(e)));
  }
  useEffect(() => { load(); }, []);

  async function save(patch: any) {
    setBusy(true); setSaved(false); setError('');
    try { const s = await api.patch('/v1/settings/tenant', patch); setSettings(s); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  const layout: string[] = settings?.leadPropertiesLayout || [];
  const ALWAYS_ON = ['phone', 'additional_phone', 'email'];

  function toggleField(key: string) {
    if (ALWAYS_ON.includes(key)) return; // pinned, can't be removed
    const next = layout.includes(key) ? layout.filter(k => k !== key) : [...layout, key];
    save({ leadPropertiesLayout: next });
  }
  function move(key: string, dir: -1 | 1) {
    const i = layout.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= layout.length) return;
    const next = [...layout];
    [next[i], next[j]] = [next[j], next[i]];
    save({ leadPropertiesLayout: next });
  }

  const labelFor = (key: string) => fields.find(f => f.schema_name === key)?.label || key;
  const allKeys = [...new Set([...ALWAYS_ON, ...fields.map(f => f.schema_name)])];

  if (!settings) return <div className="loading">Loading…</div>;

  return (
    <div>
      <div className="page-header">
        <div><h1>Lead Properties</h1><p>What shows in the Lead Properties box, and how phone numbers behave when clicked</p></div>
      </div>
      {error && <Alert>{error}</Alert>}

      <div className="card">
        <div className="card-header">Phone Click Action {saved && <Badge kind="success">Saved</Badge>}</div>
        <div className="card-body">
          <div className="form-row" style={{ maxWidth: 640 }}>
            <div className="form-group">
              <label>When a phone number is clicked</label>
              <select value={settings.phoneClickAction} disabled={busy} onChange={e => save({ phoneClickAction: e.target.value })}>
                <option value="tel">Open the device's default phone app (tel:)</option>
                <option value="url_template">Open a custom URL (e.g. a telephony/dialer web app)</option>
              </select>
            </div>
          </div>
          {settings.phoneClickAction === 'url_template' && (
            <div className="form-group" style={{ maxWidth: 640 }}>
              <label>URL template</label>
              <input placeholder="https://dialer.example.com/call?number={number}" defaultValue={settings.phoneClickUrlTemplate || ''}
                onBlur={e => save({ phoneClickUrlTemplate: e.target.value })} className="mono" />
              <div className="hint">Use <span className="mono">{'{number}'}</span> as a placeholder — it's replaced with the phone number when the link opens. For safety, arbitrary scripts can't be run here; only a URL is opened.</div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">Lead Properties Box</div>
        <div className="card-body">
          <p className="small text-muted">Phone, Additional Phone, and Email always appear and can't be removed. Reorder or add/remove the rest.</p>
          <table>
            <thead><tr><th style={{ width: 40 }}></th><th>Field</th><th style={{ width: 100 }}>Shown</th><th style={{ width: 120 }}></th></tr></thead>
            <tbody>
              {allKeys.map(key => {
                const pinned = ALWAYS_ON.includes(key);
                const shown = pinned || layout.includes(key);
                return (
                  <tr key={key}>
                    <td className="text-muted">::</td>
                    <td>{labelFor(key)} {pinned && <Badge kind="muted">Always shown</Badge>}</td>
                    <td>
                      <label className="checkbox-row" style={{ cursor: pinned ? 'default' : 'pointer' }}>
                        <input type="checkbox" checked={shown} disabled={pinned || busy} onChange={() => toggleField(key)} />
                      </label>
                    </td>
                    <td className="flex gap-8">
                      {!pinned && shown && <>
                        <button className="btn btn-sm" disabled={busy} onClick={() => move(key, -1)}>↑</button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => move(key, 1)}>↓</button>
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
