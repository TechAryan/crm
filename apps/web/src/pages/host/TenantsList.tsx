import React, { useEffect, useState } from 'react';
import { hostApi } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';

export default function TenantsList() {
  const [tenants, setTenants] = useState<any[] | null>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try {
      const [t, p] = await Promise.all([hostApi.get('/host/api/tenants'), hostApi.get('/host/api/plans')]);
      setTenants(t.items); setPlans(p.items);
    } catch (e: any) { setError(errMsg(e)); }
  }
  useEffect(() => { load(); }, []);

  async function suspend(id: string, status: string) {
    try { await hostApi.patch(`/host/api/tenants/${id}`, { status }); load(); } catch (e: any) { setError(errMsg(e)); }
  }

  async function loginAs(id: string) {
    try {
      const r = await hostApi.post(`/host/api/tenants/${id}/login-as`, {});
      setNotice(`Impersonation token generated for ${r.asUser} (tenant ${r.tenantCode}). In production this would open the tenant app in a new tab, pre-authenticated.`);
    } catch (e: any) { setError(errMsg(e)); }
  }

  return (
    <div>
      <div className="page-header">
        <div><h1>Tenants</h1><p>Every customer account provisioned on the platform</p></div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Tenant</button>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <div className="card">
        {tenants === null ? <Loading /> : (
          <table>
            <thead><tr><th>Name</th><th>Code</th><th>Subdomain</th><th>Plan</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {tenants.map(t => (
                <tr key={t.id}>
                  <td>{t.name} {t.is_test && <Badge kind="muted">test</Badge>}</td>
                  <td className="mono">{t.code}</td>
                  <td className="mono">{t.subdomain}</td>
                  <td><Badge kind="primary">{t.plan_code}</Badge></td>
                  <td><Badge kind={t.status === 'active' ? 'success' : 'danger'}>{t.status}</Badge></td>
                  <td className="flex gap-8">
                    <button className="btn btn-sm" onClick={() => loginAs(t.id)}>Login as</button>
                    {t.status === 'active'
                      ? <button className="btn btn-sm btn-danger" onClick={() => suspend(t.id, 'suspended')}>Suspend</button>
                      : <button className="btn btn-sm" onClick={() => suspend(t.id, 'active')}>Reactivate</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showCreate && <CreateTenantModal plans={plans} onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateTenantModal({ plans, onClose, onDone }: { plans: any[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [planCode, setPlanCode] = useState(plans[0]?.code || 'starter');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [template, setTemplate] = useState('generic');
  const [templates, setTemplates] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  useEffect(() => { hostApi.get('/host/api/templates').then(d => setTemplates(d.items)).catch(() => {}); }, []);

  async function submit() {
    setBusy(true); setError('');
    try {
      const r = await hostApi.post('/host/api/tenants', { name, subdomain, planCode, adminEmail, adminPassword, template });
      setResult(r);
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  if (result) {
    return (
      <Modal title="Tenant Created" onClose={onDone} footer={<button className="btn btn-primary" onClick={onDone}>Done</button>}>
        <Alert kind="success">Tenant <strong>{result.name}</strong> created with code <span className="mono">{result.code}</span>.</Alert>
        <p>Give the customer these login details:</p>
        <ul>
          <li>Tenant ID: <span className="mono">{result.code}</span> (or subdomain <span className="mono">{result.subdomain}</span>)</li>
          <li>Admin email: <span className="mono">{adminEmail}</span></li>
          <li>Password: <span className="mono">{adminPassword}</span></li>
        </ul>
      </Modal>
    );
  }

  return (
    <Modal title="New Tenant" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Provisioning…' : 'Create Tenant'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Company name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Subdomain" hint="e.g. acme → acme.yourcrm.app"><input value={subdomain} onChange={e => setSubdomain(e.target.value)} /></Field>
      <Field label="Plan">
        <select value={planCode} onChange={e => setPlanCode(e.target.value)}>
          {plans.map(p => <option key={p.code} value={p.code}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Industry template" hint={templates.find(t => t.code === template)?.description || 'Pre-loads stages, fields, activities & pipelines for the vertical'}>
        <select value={template} onChange={e => setTemplate(e.target.value)}>
          {(templates.length ? templates : [{ code: 'generic', name: 'General Sales' }]).map(t => (
            <option key={t.code} value={t.code}>{t.name}</option>
          ))}
        </select>
      </Field>
      <div className="form-row">
        <Field label="Admin email"><input type="email" value={adminEmail} onChange={e => setAdminEmail(e.target.value)} /></Field>
        <Field label="Admin password"><input type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
