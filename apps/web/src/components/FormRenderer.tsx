import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { Alert, Modal, errMsg } from '../ui';
import { FieldInput, type FieldDef } from './DynamicFields';

/**
 * Renders a custom form definition and submits it.
 * Supports sections, subheadings, required overrides, show-if visibility rules,
 * and prefilling from the current record.
 */
export function FormRunnerModal({ form, leadId, opportunityId, prefill, fieldTypeMap, onClose, onDone }: {
  form: any; leadId?: string; opportunityId?: string;
  prefill?: Record<string, any>;
  fieldTypeMap: Record<string, FieldDef>; // schemaName -> def (for input types/options)
  onClose: () => void; onDone: () => void;
}) {
  const initial = useMemo(() => {
    const v: Record<string, any> = {};
    for (const section of form.definition?.sections || []) {
      for (const item of section.items || []) {
        if (item.kind === 'field' && prefill && prefill[item.schemaName] !== undefined) v[item.schemaName] = prefill[item.schemaName];
      }
    }
    return v;
  }, [form, prefill]);

  const [values, setValues] = useState<Record<string, any>>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function isVisible(item: any): boolean {
    if (!item.showIf?.field) return true;
    const dep = values[item.showIf.field];
    if (item.showIf.op === 'notEmpty') return dep !== undefined && dep !== null && dep !== '';
    if (item.showIf.op === 'neq') return String(dep ?? '').toLowerCase() !== String(item.showIf.value ?? '').toLowerCase();
    return String(dep ?? '').toLowerCase() === String(item.showIf.value ?? '').toLowerCase();
  }

  async function submit() {
    setBusy(true); setError('');
    try {
      const cleaned = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== ''));
      await api.post(`/v1/forms/${form.id}/submit`, { leadId, opportunityId, values: cleaned });
      onDone();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  const actionLabel = form.on_submit?.action === 'post_activity' ? 'Post Activity'
    : form.on_submit?.action === 'update_opportunity' ? 'Update Opportunity' : 'Update Lead';

  return (
    <Modal title={form.name} onClose={onClose} width={620} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : actionLabel}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      {(form.definition?.sections || []).map((section: any, si: number) => (
        <div key={si} style={{ marginBottom: 18 }}>
          {section.title && <div style={{ fontWeight: 700, fontSize: 14, borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 10 }}>{section.title}</div>}
          {(section.items || []).map((item: any, ii: number) => {
            if (item.kind === 'subheading') {
              return <div key={ii} style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '14px 0 6px' }}>{item.text}</div>;
            }
            if (!isVisible(item)) return null;
            const def: FieldDef = fieldTypeMap[item.schemaName] || {
              id: item.schemaName, schema_name: item.schemaName, label: item.label || item.schemaName,
              field_type: item.schemaName === '__note' ? 'textarea' : 'text', is_mandatory: false,
            };
            return (
              <div className="form-group" key={ii}>
                <label>{item.label || def.label}{item.required && ' *'}</label>
                <FieldInput def={def} value={values[item.schemaName]} onChange={v => setValues(s => ({ ...s, [item.schemaName]: v }))} />
              </div>
            );
          })}
        </div>
      ))}
    </Modal>
  );
}

/** "Forms" button group for detail pages: lists active forms for the entity, opens the runner. */
export function FormsLauncher({ entity, leadId, opportunityId, prefill, onSubmitted }: {
  entity: 'lead' | 'opportunity'; leadId?: string; opportunityId?: string;
  prefill?: Record<string, any>; onSubmitted: () => void;
}) {
  const [forms, setForms] = useState<any[] | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const [fieldTypeMap, setFieldTypeMap] = useState<Record<string, FieldDef>>({});

  async function loadForms() {
    if (forms !== null) return;
    const d = await api.get(`/v1/forms?entity=${entity}`);
    setForms(d.items);
    // build a type map from every field source we might render
    const map: Record<string, FieldDef> = {};
    const addDefs = (items: FieldDef[]) => items.forEach(f => { map[f.schema_name] = f; });
    try { addDefs((await api.get('/v1/fields/lead')).items); } catch { /* ignore */ }
    for (const f of d.items) {
      if (f.on_submit?.action === 'post_activity' && f.on_submit.activityTypeId) {
        try { addDefs((await api.get(`/v1/activity-types/${f.on_submit.activityTypeId}/fields`)).items); } catch { /* ignore */ }
      }
    }
    setFieldTypeMap(map);
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <FormsDropdown onOpen={loadForms} forms={forms} onPick={setOpen} />
      {open && (
        <FormRunnerModal form={open} leadId={leadId} opportunityId={opportunityId} prefill={prefill}
          fieldTypeMap={fieldTypeMap} onClose={() => setOpen(null)} onDone={() => { setOpen(null); onSubmitted(); }} />
      )}
    </span>
  );
}

function FormsDropdown({ onOpen, forms, onPick }: { onOpen: () => void; forms: any[] | null; onPick: (f: any) => void }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => { setShow(s => !s); onOpen(); }}>Forms ▾</button>
      {show && (
        <div style={{ position: 'absolute', top: '110%', right: 0, background: '#fff', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.12)', minWidth: 220, zIndex: 50 }}>
          {forms === null ? <div style={{ padding: 12 }} className="text-muted small">Loading…</div>
            : forms.length === 0 ? <div style={{ padding: 12 }} className="text-muted small">No forms for this page yet — create one in Settings → Custom Forms.</div>
            : forms.map(f => (
              <div key={f.id} className="nav-link" style={{ margin: 4 }} onClick={() => { setShow(false); onPick(f); }}>{f.name}</div>
            ))}
        </div>
      )}
    </>
  );
}
