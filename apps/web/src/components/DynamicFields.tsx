import React, { useEffect, useState } from 'react';
import { api, getToken } from '../api';

export interface FieldDef {
  id: string; schema_name: string; label: string; field_type: string;
  options?: string[] | null; is_mandatory: boolean; is_unique?: boolean; section?: string;
  entity?: string; options_source?: 'static' | 'api';
}

/**
 * Resolves the option list for a choice field. Static options come straight from the
 * definition; API-sourced ones are fetched through our server (which handles auth, SSRF
 * guarding and caching) rather than from the browser.
 */
function useFieldOptions(def: FieldDef): { options: { label: string; value: string }[]; loading: boolean; error: string } {
  const staticOpts = (def.options || []).map(o => (typeof o === 'object' ? o as any : { label: String(o), value: String(o) }));
  const [state, setState] = useState<{ options: any[]; loading: boolean; error: string }>({
    options: staticOpts, loading: def.options_source === 'api', error: '',
  });

  useEffect(() => {
    if (def.options_source !== 'api' || !def.entity) return;
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: '' }));
    api.get(`/v1/fields/${def.entity}/${def.schema_name}/options`)
      .then(d => { if (!cancelled) setState({ options: d.items || [], loading: false, error: '' }); })
      .catch(e => { if (!cancelled) setState({ options: [], loading: false, error: e?.message || 'Could not load options' }); });
    return () => { cancelled = true; };
  }, [def.options_source, def.entity, def.schema_name]);

  return state;
}

/** Renders a set of custom-field inputs from field definitions (LSQ-style dynamic forms). */
export function DynamicFields({ defs, values, onChange }: {
  defs: FieldDef[]; values: Record<string, any>; onChange: (schemaName: string, value: any) => void;
}) {
  if (!defs.length) return null;
  return (
    <>
      {defs.map(d => (
        <div className="form-group" key={d.schema_name}>
          <label>{d.label}{d.is_mandatory && ' *'}{d.is_unique ? <span className="text-muted small"> (unique)</span> : null}</label>
          <FieldInput def={d} value={values[d.schema_name]} onChange={v => onChange(d.schema_name, v)} />
        </div>
      ))}
    </>
  );
}

export function FieldInput({ def, value, onChange }: { def: FieldDef; value: any; onChange: (v: any) => void }) {
  switch (def.field_type) {
    case 'textarea':
      return <textarea rows={3} value={value ?? ''} onChange={e => onChange(e.target.value)} />;
    case 'number': case 'currency':
      return <input type="number" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
    case 'date':
      return <input type="date" value={value ?? ''} onChange={e => onChange(e.target.value)} />;
    case 'datetime':
      return <input type="datetime-local" value={value ?? ''} onChange={e => onChange(e.target.value)} />;
    case 'boolean':
      return (
        <select value={value === true ? 'true' : value === false ? 'false' : ''} onChange={e => onChange(e.target.value === '' ? null : e.target.value === 'true')}>
          <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
        </select>
      );
    case 'dropdown':
      return <DropdownField def={def} value={value} onChange={onChange} />;
    case 'multiselect':
      return <MultiSelectField def={def} value={value} onChange={onChange} />;
    case 'email':
      return <input type="email" value={value ?? ''} onChange={e => onChange(e.target.value)} />;
    case 'url':
      return <input type="url" value={value ?? ''} onChange={e => onChange(e.target.value)} />;
    case 'file': case 'audio':
      return <FileField value={value} onChange={onChange} accept={def.field_type === 'audio' ? 'audio/*' : undefined} />;
    default:
      return <input value={value ?? ''} onChange={e => onChange(e.target.value)} />;
  }
}

function DropdownField({ def, value, onChange }: { def: FieldDef; value: any; onChange: (v: any) => void }) {
  const { options, loading, error } = useFieldOptions(def);
  return (
    <div>
      <select value={value ?? ''} disabled={loading} onChange={e => onChange(e.target.value || null)}>
        <option value="">{loading ? 'Loading options…' : '—'}</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        {/* Keep an existing value selectable even if the API no longer returns it. */}
        {value && !options.some(o => o.value === String(value)) && <option value={String(value)}>{String(value)}</option>}
      </select>
      {error && <div className="hint" style={{ color: 'var(--danger)' }}>{error}</div>}
    </div>
  );
}

function MultiSelectField({ def, value, onChange }: { def: FieldDef; value: any; onChange: (v: any) => void }) {
  const { options, loading, error } = useFieldOptions(def);
  const arr: string[] = Array.isArray(value) ? value : [];
  if (loading) return <div className="text-muted small">Loading options…</div>;
  return (
    <div>
      <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
        {options.map(o => (
          <label key={o.value} className="checkbox-row badge badge-muted" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={arr.includes(o.value)}
              onChange={() => onChange(arr.includes(o.value) ? arr.filter(x => x !== o.value) : [...arr, o.value])} /> {o.label}
          </label>
        ))}
      </div>
      {error && <div className="hint" style={{ color: 'var(--danger)' }}>{error}</div>}
    </div>
  );
}

/** File/audio field: uploads to /v1/files (base64), stores {fileId, name, mime} as the value, previews inline. */
function FileField({ value, onChange, accept }: { value: any; onChange: (v: any) => void; accept?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(file: File) {
    if (file.size > 8 * 1024 * 1024) { setError('Max file size is 8MB'); return; }
    setBusy(true); setError('');
    try {
      const dataBase64: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const resp = await api.post('/v1/files', { name: file.name, mime: file.type || 'application/octet-stream', dataBase64 });
      onChange({ fileId: resp.id, name: resp.name, mime: resp.mime });
    } catch (e: any) { setError(e?.message || 'Upload failed'); } finally { setBusy(false); }
  }

  return (
    <div>
      {value?.fileId ? (
        <div>
          <FilePreview fileId={value.fileId} mime={value.mime} name={value.name} />
          <div className="flex gap-8 mt-8">
            <span className="badge badge-muted">{value.name}</span>
            <button type="button" className="btn btn-sm" onClick={() => onChange(null)}>Remove</button>
          </div>
        </div>
      ) : (
        <input type="file" accept={accept} disabled={busy}
               onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      )}
      {busy && <div className="small text-muted mt-8">Uploading…</div>}
      {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
    </div>
  );
}

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000';

/** Fetches the file with auth and previews it: images inline, audio playable, pdf embedded, others as download. */
export function FilePreview({ fileId, mime, name }: { fileId: string; mime?: string; name?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objUrl: string | null = null;
    fetch(`${API_URL}/v1/files/${fileId}`, { headers: { authorization: `Bearer ${getToken()}` } })
      .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
      .then(b => { objUrl = URL.createObjectURL(b); setUrl(objUrl); })
      .catch(() => setUrl(null));
    return () => { if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [fileId]);

  if (!url) return <span className="text-muted small">…</span>;
  const m = mime || '';
  if (m.startsWith('image/')) return <img src={url} alt={name || ''} style={{ maxWidth: 220, maxHeight: 160, borderRadius: 6, border: '1px solid var(--border)' }} />;
  if (m.startsWith('audio/')) return <audio controls src={url} style={{ width: '100%', maxWidth: 320 }} />;
  if (m.startsWith('video/')) return <video controls src={url} style={{ maxWidth: 280, borderRadius: 6 }} />;
  if (m === 'application/pdf') return <iframe src={url} title={name || 'pdf'} style={{ width: '100%', height: 280, border: '1px solid var(--border)', borderRadius: 6 }} />;
  return <a href={url} download={name || 'file'} className="btn btn-sm">Download {name || 'file'}</a>;
}

export const FIELD_TYPES = ['text', 'textarea', 'number', 'currency', 'email', 'phone', 'url', 'date', 'datetime', 'boolean', 'dropdown', 'multiselect', 'file', 'audio'];
