import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';
import { FIELD_TYPES } from '../../components/DynamicFields';

const LEAD_SYSTEM_FIELDS = [
  { label: 'First Name', schema: 'first_name', type: 'Text' }, { label: 'Last Name', schema: 'last_name', type: 'Text' },
  { label: 'Email', schema: 'email', type: 'Email', unique: true }, { label: 'Phone', schema: 'phone', type: 'Phone', unique: true },
  { label: 'Lead Number', schema: 'lead_number', type: 'Number', unique: true }, { label: 'Stage', schema: 'stage_id', type: 'Dropdown' },
  { label: 'Source', schema: 'source_id', type: 'Dropdown' }, { label: 'Sub Source', schema: 'sub_source', type: 'Text' },
  { label: 'Owner', schema: 'owner_id', type: 'User' }, { label: 'Lead Score', schema: 'score', type: 'Number' },
  { label: 'Consent', schema: 'consent', type: 'Boolean' }, { label: 'Created On', schema: 'created_at', type: 'Date' },
];

export function EntityFieldsSettings({ entity, title, subtitle, showSystem }: {
  entity: string; title: string; subtitle: string; showSystem?: boolean;
}) {
  const [fields, setFields] = useState<any[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try { setFields((await api.get(`/v1/fields/${entity}`)).items); } catch (e: any) { setError(errMsg(e)); }
  }
  useEffect(() => { load(); }, [entity]);

  async function toggleActive(f: any) {
    try { await api.patch(`/v1/fields/${entity}/${f.schema_name}`, { isActive: !f.is_active }); load(); }
    catch (e: any) { setError(errMsg(e)); }
  }

  return (
    <div>
      <div className="page-header">
        <div><h1>{title}</h1><p>{subtitle}</p></div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Create Field</button>
      </div>
      {error && <Alert>{error}</Alert>}
      {showSystem && (
        <div className="card">
          <div className="card-header">System Fields</div>
          <div className="card-body">
            <table>
              <thead><tr><th>Display Name</th><th>Schema Name</th><th>Type</th><th>Unique</th><th>Created By</th></tr></thead>
              <tbody>
                {LEAD_SYSTEM_FIELDS.map(f => (
                  <tr key={f.schema} style={{ cursor: 'default' }}>
                    <td>{f.label}</td><td className="mono">{f.schema}</td><td>{f.type}</td>
                    <td>{f.unique ? 'Yes (configurable per tenant)' : '—'}</td><td><Badge kind="muted">System</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-header">Custom Fields</div>
        {fields === null ? <Loading /> : fields.length === 0 ? <div className="card-body text-muted">No custom fields yet.</div> : (
          <table>
            <thead><tr><th>Display Name</th><th>Schema Name</th><th>Type</th><th>Mandatory</th><th>Unique</th><th></th></tr></thead>
            <tbody>
              {fields.map(f => (
                <tr key={f.id} style={{ cursor: 'default' }}>
                  <td>{f.label}</td><td className="mono">{f.schema_name}</td><td>{f.field_type}</td>
                  <td>{f.is_mandatory ? 'Yes' : 'No'}</td>
                  <td>{f.is_unique ? <Badge kind="warning">Unique</Badge> : 'No'}</td>
                  <td><button className="btn btn-sm" onClick={() => toggleActive(f)}>{f.is_active ? 'Deactivate' : 'Activate'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showCreate && <CreateFieldModal entity={entity} onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

export function CreateFieldModal({ entity, onClose, onDone, apiPath }: {
  entity: string; onClose: () => void; onDone: () => void; apiPath?: string;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState('text');
  const [options, setOptions] = useState('');
  const [mandatory, setMandatory] = useState(false);
  const [unique, setUnique] = useState(false);
  const [optionsSource, setOptionsSource] = useState<'static' | 'api'>('static');
  const [optApi, setOptApi] = useState<any>({ url: '', method: 'GET', headersText: '{}', jsonPath: '', labelKey: '', valueKey: '', cacheTtlSeconds: 300 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isChoice = ['dropdown', 'multiselect'].includes(type);

  async function submit() {
    setBusy(true); setError('');
    try {
      let optionsApi: any;
      if (isChoice && optionsSource === 'api') {
        if (!optApi.url) throw new Error('An options API URL is required');
        let headers: any = {};
        if (optApi.headersText?.trim()) {
          try { headers = JSON.parse(optApi.headersText); }
          catch { throw new Error('Options API headers must be valid JSON'); }
        }
        optionsApi = {
          url: optApi.url, method: optApi.method, headers,
          jsonPath: optApi.jsonPath || undefined, labelKey: optApi.labelKey || undefined,
          valueKey: optApi.valueKey || undefined, cacheTtlSeconds: Number(optApi.cacheTtlSeconds) || 300,
        };
      }
      await api.post(apiPath || `/v1/fields/${entity}`, {
        label, type, mandatory, unique,
        optionsSource: isChoice ? optionsSource : 'static',
        optionsApi,
        options: isChoice && optionsSource === 'static' ? options.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      });
      onDone();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Create Field" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !label} onClick={submit}>{busy ? 'Saving…' : 'Create'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Display name" hint="Schema name is auto-generated (e.g. mx_city_tier) and immutable after creation">
        <input value={label} onChange={e => setLabel(e.target.value)} />
      </Field>
      <Field label="Type">
        <select value={type} onChange={e => setType(e.target.value)}>
          {FIELD_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
      </Field>
      {isChoice && (
        <>
          <Field label="Where do the options come from?">
            <select value={optionsSource} onChange={e => setOptionsSource(e.target.value as any)}>
              <option value="static">I'll type them in (fixed list)</option>
              <option value="api">Fetch live from an API</option>
            </select>
          </Field>
          {optionsSource === 'static' ? (
            <Field label="Options (comma separated)">
              <input value={options} onChange={e => setOptions(e.target.value)} placeholder="Option A, Option B" />
            </Field>
          ) : (
            <div className="card">
              <div className="card-header">Options API</div>
              <div className="card-body">
                <p className="small text-muted">
                  Called server-side (https only) and cached, so your API isn't hit on every page view.
                  Values aren't re-validated on save — your API stays the source of truth.
                </p>
                <Field label="URL">
                  <input className="mono" value={optApi.url} onChange={e => setOptApi({ ...optApi, url: e.target.value })}
                    placeholder="https://api.yoursystem.com/cities" />
                </Field>
                <div className="form-row">
                  <Field label="Method">
                    <select value={optApi.method} onChange={e => setOptApi({ ...optApi, method: e.target.value })}>
                      <option value="GET">GET</option><option value="POST">POST</option>
                    </select>
                  </Field>
                  <Field label="Cache (seconds)">
                    <input type="number" value={optApi.cacheTtlSeconds} onChange={e => setOptApi({ ...optApi, cacheTtlSeconds: e.target.value })} />
                  </Field>
                </div>
                <Field label="Headers (JSON)" hint="Kept server-side — safe for API keys">
                  <textarea rows={2} className="mono" value={optApi.headersText} onChange={e => setOptApi({ ...optApi, headersText: e.target.value })} />
                </Field>
                <div className="form-row">
                  <Field label="Array path" hint="Leave blank if the response is the array itself">
                    <input className="mono" value={optApi.jsonPath} onChange={e => setOptApi({ ...optApi, jsonPath: e.target.value })} placeholder="data.items" />
                  </Field>
                  <Field label="Label key" hint="Defaults to label/name/title">
                    <input className="mono" value={optApi.labelKey} onChange={e => setOptApi({ ...optApi, labelKey: e.target.value })} placeholder="name" />
                  </Field>
                </div>
                <Field label="Value key" hint="Defaults to value/id/code">
                  <input className="mono" value={optApi.valueKey} onChange={e => setOptApi({ ...optApi, valueKey: e.target.value })} placeholder="id" />
                </Field>
              </div>
            </div>
          )}
        </>
      )}
      <div className="checkbox-row" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={mandatory} onChange={e => setMandatory(e.target.checked)} /> Mandatory
      </div>
      <div className="checkbox-row">
        <input type="checkbox" checked={unique} onChange={e => setUnique(e.target.checked)} /> Unique — no two records may share the same value
      </div>
    </Modal>
  );
}

export function LeadFieldsSettings() {
  return <EntityFieldsSettings entity="lead" title="Lead Fields" subtitle="Manage system and custom lead fields for your account" showSystem />;
}
export function UserFieldsSettings() {
  return <EntityFieldsSettings entity="user" title="User Fields" subtitle="Manage and customize user custom fields" />;
}
