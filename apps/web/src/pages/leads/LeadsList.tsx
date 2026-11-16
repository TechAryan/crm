import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { can, useAuth } from '../../AuthContext';
import { Alert, Badge, EmptyState, Field, Loading, Modal, errMsg } from '../../ui';
import { DynamicFields, type FieldDef } from '../../components/DynamicFields';
import { HelpButton } from '../../components/HelpPanel';

interface Column { key: string; label: string; custom?: boolean }
const SYSTEM_COLUMNS: Column[] = [
  { key: 'name', label: 'Lead Name' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
  { key: 'stage', label: 'Lead Stage' }, { key: 'source', label: 'Lead Source' }, { key: 'owner', label: 'Lead Owner' },
  { key: 'score', label: 'Lead Score' }, { key: 'lead_number', label: 'Lead Number' }, { key: 'created_at', label: 'Created On' },
];
const DEFAULT_COLS = ['name', 'email', 'phone', 'stage', 'score', 'owner', 'created_at'];
const FILTER_OPS = [
  { value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'contains', label: 'contains' },
  { value: 'gt', label: '>' }, { value: 'lt', label: '<' }, { value: 'exists', label: 'has any value' },
];

export default function LeadsList() {
  const { me } = useAuth();
  const nav = useNavigate();
  const [leads, setLeads] = useState<any[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [stages, setStages] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [fieldDefs, setFieldDefs] = useState<FieldDef[]>([]);
  const [filters, setFilters] = useState<any[]>([]);
  const [selectedCols, setSelectedCols] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('nx_lead_columns') || 'null') || DEFAULT_COLS; } catch { return DEFAULT_COLS; }
  });
  const [showColumns, setShowColumns] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSaveView, setShowSaveView] = useState(false);
  const [views, setViews] = useState<any[]>([]);
  const [activeView, setActiveView] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const canEdit = can(me, 'lead', 'edit');
  const canDelete = can(me, 'lead', 'delete');
  const canImport = !!me?.permissions?.lead?.import;
  const canExport = !!me?.permissions?.lead?.export;
  const bulkable = canEdit || canDelete;

  const allColumns: Column[] = useMemo(() => [
    ...SYSTEM_COLUMNS,
    ...fieldDefs.map(f => ({ key: `fields.${f.schema_name}`, label: f.label, custom: true })),
  ], [fieldDefs]);

  async function load(activeFilters = filters, search = q) {
    try {
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      const apiFilters = activeFilters.filter(f => f.field && (f.op === 'exists' || (f.value !== '' && f.value !== undefined)));
      if (apiFilters.length) params.set('filters', JSON.stringify(apiFilters));
      params.set('limit', '50');
      const data = await api.get(`/v1/leads?${params.toString()}`);
      setLeads(data.items); setTotal(data.total); setError(''); setSelected(new Set());
    } catch (e: any) { setError(errMsg(e)); }
  }

  function loadViews() { api.get('/v1/smart-views?entity=lead').then(d => setViews(d.items)).catch(() => {}); }

  useEffect(() => {
    load();
    loadViews();
    api.get('/v1/stages').then(d => setStages(d.items)).catch(() => {});
    api.get('/v1/sources').then(d => setSources(d.items)).catch(() => {});
    api.get('/v1/users').then(d => setUsers(d.items)).catch(() => {});
    api.get('/v1/fields/lead').then(d => setFieldDefs(d.items)).catch(() => {});
  }, []);

  function saveColumns(cols: string[]) {
    setSelectedCols(cols);
    localStorage.setItem('nx_lead_columns', JSON.stringify(cols));
    setShowColumns(false);
  }

  function applyView(v: any) {
    setActiveView(v.id);
    const f = Array.isArray(v.filters) ? v.filters : [];
    setFilters(f);
    if (Array.isArray(v.columns) && v.columns.length) setSelectedCols(v.columns);
    load(f);
  }

  function clearView() { setActiveView(''); setFilters([]); load([]); }

  async function deleteView(id: string) {
    try { await api.del(`/v1/smart-views/${id}`); if (activeView === id) clearView(); loadViews(); }
    catch (e: any) { setError(errMsg(e)); }
  }

  async function exportCsv() {
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      const apiFilters = filters.filter(f => f.field && (f.op === 'exists' || (f.value !== '' && f.value !== undefined)));
      if (apiFilters.length) params.set('filters', JSON.stringify(apiFilters));
      await api.download(`/v1/leads/export?${params.toString()}`, 'leads.csv');
    } catch (e: any) { setError(errMsg(e)); }
  }

  const stageName = (id: string) => stages.find(s => s.id === id)?.name || '—';
  const sourceName = (id: string) => sources.find(s => s.id === id)?.name || '—';
  const ownerName = (id: string) => { const u = users.find(u => u.id === id); return u ? `${u.first_name} ${u.last_name || ''}`.trim() : '—'; };

  function cellValue(l: any, key: string): React.ReactNode {
    if (key === 'name') return <strong>{`${l.first_name || ''} ${l.last_name || ''}`.trim() || '—'}</strong>;
    if (key === 'stage') return <Badge kind="primary">{stageName(l.stage_id)}</Badge>;
    if (key === 'source') return sourceName(l.source_id);
    if (key === 'owner') return ownerName(l.owner_id);
    if (key === 'created_at') return new Date(l.created_at).toLocaleDateString();
    if (key.startsWith('fields.')) {
      const v = l.fields?.[key.slice(7)];
      return Array.isArray(v) ? v.join(', ') : (v ?? '—');
    }
    return l[key] ?? '—';
  }

  function toggleRow(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(s => s.size === (leads?.length || 0) ? new Set() : new Set((leads || []).map(l => l.id)));
  }

  const activeFilterCount = filters.filter(f => f.field).length;

  return (
    <div>
      <div className="page-header">
        <div className="flex gap-8" style={{ alignItems: 'center' }}>
          <div><h1>Manage Leads</h1><p>{total} total</p></div>
          <HelpButton topic="leads.list" />
        </div>
        <div className="flex gap-8">
          <input placeholder="Search name, email, phone…" value={q} onChange={e => setQ(e.target.value)}
                 onKeyDown={e => e.key === 'Enter' && load()} style={{ width: 220 }} />
          <button className="btn" onClick={() => setShowFilters(true)}>+ Filter{activeFilterCount ? ` (${activeFilterCount})` : ''}</button>
          <button className="btn" onClick={() => setShowColumns(true)}>Columns</button>
          {canExport && <button className="btn" onClick={exportCsv}>Export</button>}
          {canImport && <button className="btn" onClick={() => setShowImport(true)}>Import</button>}
          {can(me, 'lead', 'create') && <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Add New Lead</button>}
        </div>
      </div>

      <div className="flex gap-8" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span className="small text-muted">Views:</span>
        <button className={`btn btn-sm ${activeView ? '' : 'btn-primary'}`} onClick={clearView}>All Leads</button>
        {views.map(v => (
          <span key={v.id} className={`badge ${activeView === v.id ? 'badge-primary' : 'badge-muted'}`} style={{ cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span onClick={() => applyView(v)}>{v.name}{v.is_shared ? ' ·shared' : ''}</span>
            <span onClick={() => deleteView(v.id)} title="Delete view" style={{ opacity: 0.6 }}>✕</span>
          </span>
        ))}
        <button className="btn btn-sm" onClick={() => setShowSaveView(true)}>+ Save current as view</button>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {bulkable && selected.size > 0 && (
        <BulkBar count={selected.size} stages={stages} users={users} canEdit={canEdit} canDelete={canDelete}
          onClear={() => setSelected(new Set())}
          onDone={(msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); load(); }}
          ids={[...selected]} onError={setError} />
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        {leads === null ? <Loading /> : leads.length === 0 ? (
          <EmptyState title="No leads found" subtitle="Adjust filters, or create a lead / wait for one to arrive via a connector." />
        ) : (
          <table>
            <thead><tr>
              {bulkable && <th style={{ width: 32 }}><input type="checkbox" checked={selected.size === leads.length} onChange={toggleAll} /></th>}
              {selectedCols.map(k => <th key={k}>{allColumns.find(c => c.key === k)?.label || k}</th>)}
            </tr></thead>
            <tbody>
              {leads.map(l => (
                <tr key={l.id} onClick={() => nav(`/leads/${l.id}`)} style={selected.has(l.id) ? { background: 'var(--bg-selected, #eef4ff)' } : undefined}>
                  {bulkable && <td onClick={e => toggleRow(l.id, e)}><input type="checkbox" checked={selected.has(l.id)} readOnly /></td>}
                  {selectedCols.map(k => <td key={k}>{cellValue(l, k)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showColumns && <ColumnsModal all={allColumns} selected={selectedCols} onClose={() => setShowColumns(false)} onSave={saveColumns} />}
      {showFilters && (
        <FiltersModal filters={filters} fieldDefs={fieldDefs} onClose={() => setShowFilters(false)}
          onApply={f => { setFilters(f); setShowFilters(false); load(f); }} />
      )}
      {showCreate && (
        <CreateLeadModal stages={stages} sources={sources} users={users} fieldDefs={fieldDefs}
          onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
      )}
      {showImport && (
        <ImportModal fieldDefs={fieldDefs} onClose={() => setShowImport(false)}
          onDone={(msg) => { setShowImport(false); setNotice(msg); setTimeout(() => setNotice(''), 6000); load(); }} />
      )}
      {showSaveView && (
        <SaveViewModal allColumns={allColumns} columns={selectedCols} filters={filters} canShare={!!me?.permissions?.settings?.manageFields}
          onClose={() => setShowSaveView(false)} onSaved={() => { setShowSaveView(false); loadViews(); }} />
      )}
    </div>
  );
}

function BulkBar({ count, ids, stages, users, canEdit, canDelete, onClear, onDone, onError }: {
  count: number; ids: string[]; stages: any[]; users: any[]; canEdit: boolean; canDelete: boolean;
  onClear: () => void; onDone: (msg: string) => void; onError: (m: string) => void;
}) {
  const [stage, setStage] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);

  async function apply(patch: any, label: string) {
    setBusy(true);
    try { const r = await api.post('/v1/leads/bulk-update', { ids, patch }); onDone(`${label}: ${r.updated} updated, ${r.skipped} skipped.`); }
    catch (e: any) { onError(errMsg(e)); } finally { setBusy(false); }
  }
  async function del() {
    if (!confirm(`Delete ${count} lead(s)? This can't be undone from the UI.`)) return;
    setBusy(true);
    try { const r = await api.post('/v1/leads/bulk-delete', { ids }); onDone(`Deleted ${r.deleted}, skipped ${r.skipped}.`); }
    catch (e: any) { onError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <div className="card flex gap-8" style={{ alignItems: 'center', padding: '8px 12px', marginBottom: 12, flexWrap: 'wrap' }}>
      <strong>{count} selected</strong>
      {canEdit && <>
        <select value={stage} disabled={busy} onChange={e => { setStage(e.target.value); if (e.target.value) apply({ stage: e.target.value }, 'Stage change'); e.target.value = ''; setStage(''); }}>
          <option value="">Change stage…</option>
          {stages.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
        <select value={ownerId} disabled={busy} onChange={e => { setOwnerId(e.target.value); if (e.target.value) apply({ ownerId: e.target.value }, 'Reassign'); e.target.value = ''; setOwnerId(''); }}>
          <option value="">Assign owner…</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.first_name} {u.last_name || ''}</option>)}
        </select>
      </>}
      {canDelete && <button className="btn btn-sm" disabled={busy} onClick={del} style={{ color: 'var(--danger, #c0392b)' }}>Delete</button>}
      <button className="btn btn-sm" onClick={onClear}>Clear</button>
    </div>
  );
}

function ImportModal({ fieldDefs, onClose, onDone }: { fieldDefs: FieldDef[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [step, setStep] = useState<'upload' | 'map'>('upload');
  const [csv, setCsv] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({});
  const [dedupeMode, setDedupeMode] = useState('update');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const destOptions = [
    { key: '', label: '— Ignore —' },
    { key: 'firstName', label: 'First Name' }, { key: 'lastName', label: 'Last Name' },
    { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'source', label: 'Source' },
    ...fieldDefs.map(f => ({ key: `fields.${f.schema_name}`, label: `${f.label} (custom)` })),
  ];

  function parseHeaders(text: string) {
    const firstLine = (text.split(/\r?\n/)[0] || '').trim();
    if (!firstLine) { setError('CSV appears empty.'); return; }
    // simple header split respecting quotes
    const cols: string[] = []; let cur = ''; let inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cols.push(cur.trim());
    setHeaders(cols);
    // auto-map by fuzzy name match
    const auto: Record<string, string> = {};
    for (const h of cols) {
      const low = h.toLowerCase();
      const match = destOptions.find(o => o.key && (o.label.toLowerCase() === low || o.key.toLowerCase() === low));
      if (match) auto[h] = match.key;
    }
    setFieldMap(auto);
    setStep('map'); setError('');
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { const text = String(r.result || ''); setCsv(text); parseHeaders(text); };
    r.readAsText(f);
  }

  async function submit() {
    const map = Object.fromEntries(Object.entries(fieldMap).filter(([, v]) => v));
    if (!Object.keys(map).length) { setError('Map at least one column.'); return; }
    setBusy(true); setError('');
    try {
      const job = await api.post('/v1/imports/leads', { csv, fieldMap: map, dedupeMode });
      onDone(`Import done: ${job.created_count} created, ${job.updated_count} updated, ${job.error_count} errors.`);
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Import Leads from CSV" onClose={onClose} width={640} footer={step === 'map' ? <>
      <button className="btn" onClick={() => setStep('upload')}>Back</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Importing…' : 'Import'}</button>
    </> : <button className="btn" onClick={onClose}>Cancel</button>}>
      {error && <Alert>{error}</Alert>}
      {step === 'upload' ? (
        <div>
          <p className="small text-muted">Upload a .csv file. The first row must contain column headers.</p>
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
          <p className="small text-muted mt-8">Or paste CSV text:</p>
          <textarea rows={6} value={csv} onChange={e => setCsv(e.target.value)} placeholder="Name,Email,Phone&#10;Jane,jane@x.com,555…" style={{ width: '100%' }} />
          {csv && <button className="btn btn-sm mt-8" onClick={() => parseHeaders(csv)}>Next: map columns</button>}
        </div>
      ) : (
        <div>
          <p className="small text-muted">Match each CSV column to a lead field. Unmapped columns are ignored.</p>
          {headers.map(h => (
            <div className="flex gap-8 mt-8" key={h} style={{ alignItems: 'center' }}>
              <div style={{ flex: 1 }}><strong>{h}</strong></div>
              <span className="text-muted">→</span>
              <select style={{ flex: 1 }} value={fieldMap[h] || ''} onChange={e => setFieldMap(m => ({ ...m, [h]: e.target.value }))}>
                {destOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <Field label="On duplicate (matched by email/phone)">
              <select value={dedupeMode} onChange={e => setDedupeMode(e.target.value)}>
                <option value="update">Update existing lead</option>
                <option value="skip">Skip (don't update)</option>
                <option value="create">Always create new</option>
              </select>
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SaveViewModal({ allColumns, columns, filters, canShare, onClose, onSaved }: {
  allColumns: Column[]; columns: string[]; filters: any[]; canShare: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [isShared, setIsShared] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const activeFilters = filters.filter(f => f.field);

  async function save() {
    if (!name.trim()) { setError('Name required'); return; }
    setBusy(true); setError('');
    try {
      await api.post('/v1/smart-views', { entity: 'lead', name: name.trim(), filters: activeFilters, columns, isShared });
      onSaved();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Save Smart View" onClose={onClose} width={520} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save View'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="View name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Hot Mumbai leads" /></Field>
      <p className="small text-muted">Captures {activeFilters.length} filter(s) and {columns.length} column(s).</p>
      {canShare && (
        <label className="checkbox-row"><input type="checkbox" checked={isShared} onChange={e => setIsShared(e.target.checked)} /> Share with the whole team</label>
      )}
    </Modal>
  );
}

function ColumnsModal({ all, selected, onClose, onSave }: { all: Column[]; selected: string[]; onClose: () => void; onSave: (cols: string[]) => void }) {
  const [cols, setCols] = useState<string[]>(selected);
  function toggle(k: string) { setCols(c => c.includes(k) ? c.filter(x => x !== k) : [...c, k]); }
  return (
    <Modal title="Manage Columns" onClose={onClose} width={560} footer={<>
      <button className="btn" onClick={() => onSave(['name', 'email', 'phone', 'stage', 'score', 'owner', 'created_at'])}>Restore Default</button>
      <button className="btn btn-primary" onClick={() => onSave(cols)}>Update</button>
    </>}>
      <p className="small text-muted">Select which columns show in the lead grid — including your custom fields. Saved per browser.</p>
      <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
        {all.map(c => (
          <label key={c.key} className="checkbox-row badge badge-muted" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={cols.includes(c.key)} onChange={() => toggle(c.key)} /> {c.label}{c.custom ? ' •' : ''}
          </label>
        ))}
      </div>
    </Modal>
  );
}

function FiltersModal({ filters, fieldDefs, onClose, onApply }: {
  filters: any[]; fieldDefs: FieldDef[]; onClose: () => void; onApply: (f: any[]) => void;
}) {
  const [conds, setConds] = useState<any[]>(filters.length ? filters : [{ field: '', op: 'eq', value: '' }]);
  const filterableFields = [
    { key: 'first_name', label: 'First Name' }, { key: 'last_name', label: 'Last Name' },
    { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'score', label: 'Lead Score' },
    { key: 'sub_source', label: 'Sub Source' },
    ...fieldDefs.map(f => ({ key: `fields.${f.schema_name}`, label: `${f.label} (custom)` })),
  ];
  function setCond(i: number, k: string, v: any) { setConds(c => c.map((x, idx) => idx === i ? { ...x, [k]: v } : x)); }
  function add() { setConds(c => [...c, { field: '', op: 'eq', value: '' }]); }
  function remove(i: number) { setConds(c => c.filter((_, idx) => idx !== i)); }

  return (
    <Modal title="Advanced Filters" onClose={onClose} width={640} footer={<>
      <button className="btn" onClick={() => onApply([])}>Clear All</button>
      <button className="btn btn-primary" onClick={() => onApply(conds.filter(c => c.field))}>Apply Filters</button>
    </>}>
      <p className="small text-muted">All conditions must match (AND). Works on system and custom fields.</p>
      {conds.map((c, i) => (
        <div className="flex gap-8 mt-8" key={i}>
          <select value={c.field} onChange={e => setCond(i, 'field', e.target.value)} style={{ flex: 2 }}>
            <option value="">Select field…</option>
            {filterableFields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <select value={c.op} onChange={e => setCond(i, 'op', e.target.value)} style={{ flex: 1 }}>
            {FILTER_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {c.op !== 'exists' && <input value={c.value ?? ''} onChange={e => setCond(i, 'value', e.target.value)} placeholder="Value" style={{ flex: 2 }} />}
          <button className="btn btn-sm" onClick={() => remove(i)}>✕</button>
        </div>
      ))}
      <button className="btn btn-sm mt-8" onClick={add}>+ AND condition</button>
    </Modal>
  );
}

function CreateLeadModal({ stages, sources, users, fieldDefs, onClose, onCreated }: {
  stages: any[]; sources: any[]; users: any[]; fieldDefs: FieldDef[]; onClose: () => void; onCreated: () => void;
}) {
  const [form, setForm] = useState<any>({ firstName: '', lastName: '', email: '', phone: '', stage: '', source: 'Manual', ownerId: '' });
  const [fields, setFields] = useState<Record<string, any>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  async function submit() {
    setBusy(true); setError('');
    try {
      await api.post('/v1/leads', {
        ...form, stage: form.stage || undefined, ownerId: form.ownerId || undefined,
        fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v !== null && v !== undefined)),
        consent: true,
      });
      onCreated();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Add New Lead" onClose={onClose} width={620} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Create Lead'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <div className="form-row">
        <Field label="First name"><input value={form.firstName} onChange={e => set('firstName', e.target.value)} /></Field>
        <Field label="Last name"><input value={form.lastName} onChange={e => set('lastName', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Email"><input type="email" value={form.email} onChange={e => set('email', e.target.value)} /></Field>
        <Field label="Phone"><input value={form.phone} onChange={e => set('phone', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Stage">
          <select value={form.stage} onChange={e => set('stage', e.target.value)}>
            <option value="">Default</option>
            {stages.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Source">
          <select value={form.source} onChange={e => set('source', e.target.value)}>
            {sources.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Owner" hint="Leave empty to let distribution rules assign">
        <select value={form.ownerId} onChange={e => set('ownerId', e.target.value)}>
          <option value="">Auto-assign (distribution rules)</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>)}
        </select>
      </Field>
      <DynamicFields defs={fieldDefs} values={fields} onChange={(k, v) => setFields(f => ({ ...f, [k]: v }))} />
    </Modal>
  );
}
