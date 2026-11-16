import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { can, useAuth } from '../../AuthContext';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';
import { DynamicFields, type FieldDef } from '../../components/DynamicFields';
import { FormsLauncher } from '../../components/FormRenderer';
import AuditTimeline from '../../components/AuditTimeline';
import { CustomActionButtons } from '../../components/CustomActionButtons';
import { WidgetsForPlacement } from '../../components/EmbeddedWidget';

type Tab = 'activity' | 'details' | 'opportunities' | 'tasks' | 'notes' | 'history';

export default function LeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { me } = useAuth();
  const [lead, setLead] = useState<any>(null);
  const [stages, setStages] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [fieldDefs, setFieldDefs] = useState<FieldDef[]>([]);
  const [activityTypes, setActivityTypes] = useState<any[]>([]);
  const [tenantSettings, setTenantSettings] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('activity');
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'activity' | 'opportunity' | 'task' | null>(null);

  const [activities, setActivities] = useState<any[] | null>(null);
  const [opportunities, setOpportunities] = useState<any[] | null>(null);
  const [tasks, setTasks] = useState<any[] | null>(null);
  const [notes, setNotes] = useState<any[] | null>(null);

  async function load() {
    try {
      const [l, s, so, at, fd, u, ts] = await Promise.all([
        api.get(`/v1/leads/${id}`), api.get('/v1/stages'), api.get('/v1/sources'),
        api.get('/v1/activity-types'), api.get('/v1/fields/lead'), api.get('/v1/users').catch(() => ({ items: [] })),
        api.get('/v1/settings/tenant').catch(() => null),
      ]);
      setLead(l); setStages(s.items); setSources(so.items); setActivityTypes(at.items); setFieldDefs(fd.items); setUsers(u.items); setTenantSettings(ts);
    } catch (e: any) { setError(errMsg(e)); }
  }
  const loadActivities = () => api.get(`/v1/leads/${id}/activities`).then(d => setActivities(d.items));
  const loadOpps = () => api.get(`/v1/opportunities?leadId=${id}`).then(d => setOpportunities(d.items));
  const loadTasks = () => api.get(`/v1/tasks?leadId=${id}`).then(d => setTasks(d.items));
  const loadNotes = () => api.get(`/v1/leads/${id}/notes`).then(d => setNotes(d.items));

  useEffect(() => { load(); loadActivities(); }, [id]);
  useEffect(() => {
    if (tab === 'opportunities' && opportunities === null) loadOpps();
    if (tab === 'tasks' && tasks === null) loadTasks();
    if (tab === 'notes' && notes === null) loadNotes();
  }, [tab]);

  async function patchLead(body: any) {
    try { setLead(await api.patch(`/v1/leads/${id}`, body)); setError(''); }
    catch (e: any) { setError(errMsg(e)); }
  }

  if (error && !lead) return <Alert>{error}</Alert>;
  if (!lead) return <Loading />;

  const stageName = stages.find(s => s.id === lead.stage_id)?.name || '';
  const sourceName = sources.find(s => s.id === lead.source_id)?.name || '—';
  const owner = users.find(u => u.id === lead.owner_id);
  const canEdit = can(me, 'lead', 'edit');

  return (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={() => nav('/leads')}>← Manage Leads</button>
      <div className="card mt-8">
        <div className="card-body flex-between">
          <div className="flex gap-8" style={{ alignItems: 'center' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 17 }}>
              {(lead.first_name || lead.email || '?')[0]?.toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>
                {`${lead.first_name || ''} ${lead.last_name || ''}`.trim() || lead.email || lead.phone}
                {' '}<Badge kind="primary">{stageName}</Badge>
              </div>
              <div className="text-muted small">{lead.email || 'no email'} · {lead.phone || 'no phone'} · #{lead.lead_number} · Score {lead.score}</div>
            </div>
          </div>
          <div className="flex gap-8">
            <FormsLauncher entity="lead" leadId={id} prefill={{ firstName: lead.first_name, lastName: lead.last_name, email: lead.email, phone: lead.phone, ...(lead.fields || {}) }}
              onSubmitted={() => { load(); loadActivities(); }} />
            <CustomActionButtons entity="lead" recordId={id!} onDone={() => { load(); loadActivities(); }} />
            {can(me, 'activity', 'create') && <button className="btn" onClick={() => setModal('activity')}>Log Activity</button>}
            {can(me, 'opportunity', 'create') && <button className="btn" onClick={() => setModal('opportunity')}>+ Opportunity</button>}
            {can(me, 'task', 'create') && <button className="btn" onClick={() => setModal('task')}>+ Task</button>}
            <select value={stageName} onChange={e => patchLead({ stage: e.target.value })} disabled={!canEdit} style={{ width: 170 }}>
              {stages.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </div>
        </div>
      </div>
      {error && <div className="mt-8"><Alert>{error}</Alert></div>}

      <div className="lead-detail-layout" style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginTop: 16 }}>
        <div className="card lead-detail-sidebar" style={{ width: 250, flexShrink: 0 }}>
          <div className="card-header">Lead Properties</div>
          <div className="card-body">
            <LeadPropertiesBox lead={lead} fieldDefs={fieldDefs} owner={owner} stageName={stageName} sourceName={sourceName} settings={tenantSettings} />
            {canEdit && (
              <div className="form-group mt-8">
                <label>Reassign owner</label>
                <select value={lead.owner_id || ''} onChange={e => patchLead({ ownerId: e.target.value || undefined })}>
                  <option value="">Unassigned</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tabs">
            {([['activity', 'Activity History'], ['details', 'Lead Details'], ['opportunities', 'Opportunities'], ['tasks', 'Tasks'], ['notes', 'Notes'], ['history', 'History']] as [Tab, string][]).map(([k, label]) => (
              <div key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</div>
            ))}
          </div>

          {tab === 'activity' && (
            <div className="card"><div className="card-body">
              {activities === null ? <Loading /> : activities.length === 0 ? <p className="text-muted">No activity yet.</p> : activities.map(a => (
                <div className="timeline-item" key={a.id}>
                  <div className="timeline-dot" />
                  <div className="timeline-body">
                    <div><strong>{a.type_name}</strong>{a.note ? ` — ${a.note}` : ''}</div>
                    {a.fields && Object.keys(a.fields).length > 0 && (
                      <div className="small text-muted">{Object.entries(a.fields).map(([k, v]) => `${k.replace(/^mx_/, '')}: ${v}`).join(' · ')}</div>
                    )}
                    <div className="timeline-time">{new Date(a.activity_time).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div></div>
          )}

          {tab === 'details' && (
            <DetailsTab lead={lead} fieldDefs={fieldDefs} canEdit={canEdit} onSave={patchLead} />
          )}

          {tab === 'opportunities' && (
            <div className="card">
              <div className="card-header">Opportunities {can(me, 'opportunity', 'create') && <button className="btn btn-sm btn-primary" onClick={() => setModal('opportunity')}>+ New</button>}</div>
              {opportunities === null ? <Loading /> : opportunities.length === 0 ? <div className="card-body text-muted">No opportunities on this lead.</div> : (
                <table>
                  <thead><tr><th>Name</th><th>Type</th><th>Stage</th><th>Status</th><th>Amount</th></tr></thead>
                  <tbody>{opportunities.map(o => (
                    <tr key={o.id} style={{ cursor: 'default' }}>
                      <td>{o.name}</td><td>{o.type_name}</td><td>{o.stage}</td>
                      <td><Badge kind={o.status === 'Won' ? 'success' : o.status === 'Lost' ? 'danger' : 'warning'}>{o.status}</Badge></td>
                      <td>{o.currency} {Number(o.amount).toLocaleString()}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'tasks' && (
            <div className="card">
              <div className="card-header">Tasks {can(me, 'task', 'create') && <button className="btn btn-sm btn-primary" onClick={() => setModal('task')}>+ Add Task</button>}</div>
              {tasks === null ? <Loading /> : tasks.length === 0 ? <div className="card-body text-muted">No tasks on this lead.</div> : (
                <table>
                  <thead><tr><th>Name</th><th>Kind</th><th>Due</th><th>Status</th></tr></thead>
                  <tbody>{tasks.map(t => (
                    <tr key={t.id} style={{ cursor: 'default' }}>
                      <td>{t.name}</td><td>{t.kind}</td>
                      <td>{t.due_at ? new Date(t.due_at).toLocaleString() : '—'}</td>
                      <td><Badge kind={t.status === 'done' ? 'success' : 'warning'}>{t.status}</Badge></td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'notes' && (
            <NotesTab leadId={id!} notes={notes} reload={loadNotes} />
          )}

          {/* Tenant-defined embedded widgets (iframe / HTML) for the lead page. */}
          {tab === 'details' && <WidgetsForPlacement placement="lead_tab" entity="lead" recordId={id!} />}

          {tab === 'history' && (
            <div className="card"><div className="card-header">Change History</div><div className="card-body">
              <AuditTimeline leadId={id!} />
            </div></div>
          )}
        </div>
      </div>

      {modal === 'activity' && (
        <LogActivityModal leadId={id!} types={activityTypes} onClose={() => setModal(null)}
          onLogged={() => { setModal(null); loadActivities(); load(); }} />
      )}
      {modal === 'opportunity' && (
        <NewOpportunityModal leadId={id!} onClose={() => setModal(null)}
          onCreated={() => { setModal(null); loadOpps(); setTab('opportunities'); }} />
      )}
      {modal === 'task' && (
        <NewTaskModal leadId={id!} onClose={() => setModal(null)}
          onCreated={() => { setModal(null); loadTasks(); setTab('tasks'); }} />
      )}
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="flex-between mt-8"><span className="text-muted small">{label}</span><span className="small" style={{ textAlign: 'right' }}>{value}</span></div>;
}

/** Turns a phone number into a clickable link per the tenant's phoneClickAction setting:
 *  either the device's default phone app (tel:) or a custom URL template (e.g. a telephony/dialer
 *  web app), with {number} substituted — never arbitrary script execution, for safety. */
function PhoneLink({ number, settings }: { number: string; settings: any }) {
  if (!number) return <>—</>;
  const action = settings?.phoneClickAction || 'tel';
  const href = action === 'url_template' && settings?.phoneClickUrlTemplate
    ? settings.phoneClickUrlTemplate.replace('{number}', encodeURIComponent(number))
    : `tel:${number}`;
  return <a href={href} target={action === 'url_template' ? '_blank' : undefined} rel="noreferrer">{number}</a>;
}

/** Renders the Lead Properties summary box. Phone / Additional Phone / Email are always shown
 *  first regardless of the tenant's configured layout; the rest follows Settings > Lead Properties. */
function LeadPropertiesBox({ lead, fieldDefs, owner, stageName, sourceName, settings }: {
  lead: any; fieldDefs: FieldDef[]; owner: any; stageName: string; sourceName: string; settings: any;
}) {
  const layout: string[] = settings?.leadPropertiesLayout || ['owner', 'source', 'score'];
  const ALWAYS_ON = ['phone', 'additional_phone', 'email'];
  const rest = layout.filter(k => !ALWAYS_ON.includes(k));

  const labelFor = (key: string) => fieldDefs.find(d => d.schema_name === key)?.label
    || key.replace(/^mx_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  function valueFor(key: string): React.ReactNode {
    switch (key) {
      case 'owner': return owner ? `${owner.first_name} ${owner.last_name || ''}` : 'Unassigned';
      case 'source': return sourceName;
      case 'score': return String(lead.score ?? 0);
      case 'stage': return stageName;
      case 'lead_number': return `#${lead.lead_number}`;
      case 'created_at': return new Date(lead.created_at).toLocaleString();
      case 'updated_at': return new Date(lead.updated_at).toLocaleString();
      case 'first_name': return lead.first_name || '—';
      case 'last_name': return lead.last_name || '—';
      case 'sub_source': return lead.sub_source || '—';
      default: {
        const v = lead.fields?.[key];
        return Array.isArray(v) ? v.join(', ') : (v ?? '—');
      }
    }
  }

  return (
    <div>
      <PropRow label="Phone" value={<PhoneLink number={lead.phone} settings={settings} />} />
      <PropRow label="Additional Phone" value={<PhoneLink number={lead.additional_phone} settings={settings} />} />
      <PropRow label="Email" value={lead.email || '—'} />
      {rest.map(key => <PropRow key={key} label={labelFor(key)} value={valueFor(key)} />)}
    </div>
  );
}

function DetailsTab({ lead, fieldDefs, canEdit, onSave }: { lead: any; fieldDefs: FieldDef[]; canEdit: boolean; onSave: (b: any) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<any>({});
  const [fields, setFields] = useState<Record<string, any>>({});

  function startEdit() {
    setForm({ firstName: lead.first_name || '', lastName: lead.last_name || '', email: lead.email || '', phone: lead.phone || '' });
    setFields({ ...(lead.fields || {}) });
    setEditing(true);
  }
  async function save() {
    await onSave({ ...form, fields });
    setEditing(false);
  }

  return (
    <div className="card">
      <div className="card-header">Lead Details {canEdit && !editing && <button className="btn btn-sm" onClick={startEdit}>Edit</button>}
        {editing && <span className="flex gap-8"><button className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button><button className="btn btn-sm btn-primary" onClick={save}>Save</button></span>}
      </div>
      <div className="card-body">
        {!editing ? (
          <table>
            <tbody>
              <tr style={{ cursor: 'default' }}><td className="text-muted" style={{ width: 220 }}>First Name</td><td>{lead.first_name || '—'}</td></tr>
              <tr style={{ cursor: 'default' }}><td className="text-muted">Last Name</td><td>{lead.last_name || '—'}</td></tr>
              <tr style={{ cursor: 'default' }}><td className="text-muted">Email</td><td>{lead.email || '—'}</td></tr>
              <tr style={{ cursor: 'default' }}><td className="text-muted">Phone</td><td>{lead.phone || '—'}</td></tr>
              {fieldDefs.map(d => (
                <tr key={d.schema_name} style={{ cursor: 'default' }}>
                  <td className="text-muted">{d.label}</td>
                  <td>{Array.isArray(lead.fields?.[d.schema_name]) ? lead.fields[d.schema_name].join(', ') : (lead.fields?.[d.schema_name] ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ maxWidth: 520 }}>
            <div className="form-row">
              <Field label="First name"><input value={form.firstName} onChange={e => setForm((f: any) => ({ ...f, firstName: e.target.value }))} /></Field>
              <Field label="Last name"><input value={form.lastName} onChange={e => setForm((f: any) => ({ ...f, lastName: e.target.value }))} /></Field>
            </div>
            <div className="form-row">
              <Field label="Email"><input value={form.email} onChange={e => setForm((f: any) => ({ ...f, email: e.target.value }))} /></Field>
              <Field label="Phone"><input value={form.phone} onChange={e => setForm((f: any) => ({ ...f, phone: e.target.value }))} /></Field>
            </div>
            <DynamicFields defs={fieldDefs} values={fields} onChange={(k, v) => setFields(f => ({ ...f, [k]: v }))} />
          </div>
        )}
      </div>
    </div>
  );
}

function NotesTab({ leadId, notes, reload }: { leadId: string; notes: any[] | null; reload: () => void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add() {
    if (!body.trim()) return;
    setBusy(true); setError('');
    try { await api.post(`/v1/leads/${leadId}/notes`, { body }); setBody(''); reload(); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <div className="card-header">Notes</div>
      <div className="card-body">
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-8">
          <input placeholder="Write a note…" value={body} onChange={e => setBody(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
          <button className="btn btn-primary" disabled={busy} onClick={add}>Add</button>
        </div>
        <div className="mt-16">
          {notes === null ? <Loading /> : notes.length === 0 ? <p className="text-muted">No notes yet.</p> : notes.map(n => (
            <div className="timeline-item" key={n.id}>
              <div className="timeline-dot" />
              <div className="timeline-body">
                <div>{n.body}</div>
                <div className="timeline-time">{n.author_first ? `${n.author_first} ${n.author_last || ''} · ` : ''}{new Date(n.created_at).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LogActivityModal({ leadId, types, onClose, onLogged }: { leadId: string; types: any[]; onClose: () => void; onLogged: () => void }) {
  const [typeId, setTypeId] = useState(types[0]?.id || '');
  const [note, setNote] = useState('');
  const [typeFields, setTypeFields] = useState<FieldDef[]>([]);
  const [fields, setFields] = useState<Record<string, any>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setFields({});
    if (typeId) api.get(`/v1/activity-types/${typeId}/fields`).then(d => setTypeFields(d.items)).catch(() => setTypeFields([]));
  }, [typeId]);

  async function submit() {
    setBusy(true); setError('');
    try {
      await api.post(`/v1/leads/${leadId}/activities`, {
        typeId, note,
        fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v !== null && v !== undefined)),
      });
      onLogged();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Log Activity" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Log Activity'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Activity type">
        <select value={typeId} onChange={e => setTypeId(e.target.value)}>
          {types.map(t => <option key={t.id} value={t.id}>{t.name}{t.score ? ` (${t.score > 0 ? '+' : ''}${t.score})` : ''}</option>)}
        </select>
      </Field>
      <DynamicFields defs={typeFields} values={fields} onChange={(k, v) => setFields(f => ({ ...f, [k]: v }))} />
      <Field label="Note"><textarea rows={3} value={note} onChange={e => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

function NewOpportunityModal({ leadId, onClose, onCreated }: { leadId: string; onClose: () => void; onCreated: () => void }) {
  const [types, setTypes] = useState<any[]>([]);
  const [typeId, setTypeId] = useState('');
  const [typeFields, setTypeFields] = useState<FieldDef[]>([]);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState<number>(0);
  const [stage, setStage] = useState('');
  const [fields, setFields] = useState<Record<string, any>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/v1/opportunity-types').then(d => { setTypes(d.items); if (d.items[0]) setTypeId(d.items[0].id); });
  }, []);
  useEffect(() => {
    setFields({}); setStage('');
    if (typeId) api.get(`/v1/opportunity-types/${typeId}/fields`).then(d => setTypeFields(d.items)).catch(() => setTypeFields([]));
  }, [typeId]);

  const selectedType = types.find(t => t.id === typeId);
  const stages = selectedType?.stages || [];

  async function submit() {
    setBusy(true); setError('');
    try {
      await api.post('/v1/opportunities', {
        leadId, opportunityTypeId: typeId, name, amount, stage: stage || undefined,
        fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v !== null && v !== undefined)),
      });
      onCreated();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="New Opportunity" onClose={onClose} width={620} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name || !typeId} onClick={submit}>{busy ? 'Saving…' : 'Create Opportunity'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <div className="form-row">
        <Field label="Opportunity type">
          <select value={typeId} onChange={e => setTypeId(e.target.value)}>
            {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Stage">
          <select value={stage} onChange={e => setStage(e.target.value)}>
            <option value="">First stage</option>
            {stages.map((s: any) => <option key={s.name} value={s.name}>{s.name} ({s.status})</option>)}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Opportunity name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Ravi — Online Course" /></Field>
        <Field label="Amount (INR)"><input type="number" value={amount} onChange={e => setAmount(Number(e.target.value))} /></Field>
      </div>
      <DynamicFields defs={typeFields} values={fields} onChange={(k, v) => setFields(f => ({ ...f, [k]: v }))} />
    </Modal>
  );
}

function NewTaskModal({ leadId, onClose, onCreated }: { leadId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('todo');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError('');
    try { await api.post('/v1/tasks', { leadId, name, kind, dueAt: dueAt || undefined }); onCreated(); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Add Task" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !name} onClick={submit}>{busy ? 'Saving…' : 'Add Task'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Task name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
      <div className="form-row">
        <Field label="Kind">
          <select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="todo">To-Do</option><option value="appointment">Appointment</option>
          </select>
        </Field>
        <Field label="Due"><input type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
