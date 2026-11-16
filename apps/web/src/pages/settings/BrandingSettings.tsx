import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Field, Loading, errMsg } from '../../ui';

export default function BrandingSettings() {
  const [loaded, setLoaded] = useState(false);
  const [appName, setAppName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#4f46e5');
  const [msg, setMsg] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/v1/branding').then(d => {
      setAppName(d.branding?.appName || '');
      setLogoUrl(d.branding?.logoUrl || '');
      setPrimaryColor(d.branding?.primaryColor || '#4f46e5');
      setLoaded(true);
    }).catch(e => { setMsg({ kind: 'danger', text: errMsg(e) }); setLoaded(true); });
  }, []);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api.patch('/v1/branding', { appName, logoUrl, primaryColor });
      localStorage.setItem('nx_branding', JSON.stringify({ appName, logoUrl, primaryColor }));
      setMsg({ kind: 'success', text: 'Branding saved. Reload the page to see it applied everywhere.' });
    } catch (e: any) { setMsg({ kind: 'danger', text: errMsg(e) }); } finally { setBusy(false); }
  }

  if (!loaded) return <Loading />;
  return (
    <div>
      <div className="page-header"><div><h1>Branding</h1><p>White-label this CRM for your team — name, logo, and accent color</p></div></div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="card"><div className="card-body" style={{ maxWidth: 480 }}>
        <Field label="App name" hint="Shown in the sidebar instead of 'NexCRM'"><input value={appName} onChange={e => setAppName(e.target.value)} placeholder="Acme Sales" /></Field>
        <Field label="Logo URL" hint="Square image works best; shown next to the app name"><input value={logoUrl} onChange={e => setLogoUrl(e.target.value)} placeholder="https://…/logo.png" /></Field>
        <Field label="Primary color">
          <div className="flex gap-8">
            <input type="color" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} style={{ width: 48, padding: 2 }} />
            <input value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} style={{ width: 120 }} />
          </div>
        </Field>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save Branding'}</button>
      </div></div>
    </div>
  );
}
