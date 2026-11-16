import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { can, useAuth } from '../../AuthContext';
import { Alert, Badge, Field, Loading, Modal, errMsg } from '../../ui';
import { DynamicFields, type FieldDef } from '../../components/DynamicFields';
import { FormsLauncher } from '../../components/FormRenderer';
import AuditTimeline from '../../components/AuditTimeline';

export default function OpportunityDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { me } = useAuth();
  const [opp, setOpp] = useState<any>(null);
  const [type, setType] = useState<any>(null);
  const [typeFields, setTypeFields] = useState<FieldDef[]>([]);
  const [activities, setActivities] = useState<any[] | null>(null);
  const [activityTypes, setActivityTypes] = useState<any[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const opps = await api.get('/v1/opportunities');
      const one = opps.items.find((o: any) => o.id === id);
      if (!one) throw new Error('Opportunity not found');
      setOpp(one);
      const types = await api.get('/v1/opportunity-types');
      const t = types.items.find((x: any) => x.id === one.opportunity_type_id);
      setType(t);
      setTypeFields((await api.get(`/v1/opportunity-types/${one.opportunity_type_id}/fields`)).items);
      setActivityTypes((await api.get('/v1/activity-types')).items);
    } catch (e: any) { setError(errMsg(e)); }
  }
  const loadActivities = () => api.get(`/v1/activities?opportunityId=${id}`).then(d => setActivities(d.items));

  useEffect(() => { load(); loadActivities(); }, [id]);

  async function changeStage(stage: string) {
    try { setOpp(await api.patch(`/v1/opportunities/${id}`, { stage })); }
    catch (e: any) { setError(errMsg(e)); }
  }

  if (error && !opp) return <Alert>{error}</Alert>;
  if (!opp) return <Loading />;

  return (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={() => nav('/opportunities')}>← Opportunities</button>
      <div className="card mt-8">
        <div className="card-body flex-between">
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              {opp.name} <Badge kind={opp.status === 'Won' ? 'success' : opp.status === 'Lost' ? 'danger' : 'warning'}>{opp.status}</Badge>
            </div>
            <div className="text-muted small">{type?.name} · {opp.currency} {Number(opp.amount).toLocaleString()} · created {new Date(opp.created_at).toLocaleDateString()}</div>
          </div>
          <div className="flex gap-8">
            <FormsLauncher entity="opportunity" opportunityId={id} leadId={opp.lead_id} prefill={opp.fields} onSubmitted={() => { load(); loadActivities(); }} />
            {can(me, 'activity', 'create') && <button className="btn" onClick={() => setShowLog(true)}>Log Activity</button>}
            <button className="btn" onClick={() => nav(`/leads/${opp.lead_id}`)}>View Lead →</button>
            <select value={opp.stage} onChange={e => changeStage(e.target.value)} disabled={!can(me, 'opportunity', 'edit')} style={{ width: 190 }}>
              {(type?.stages || []).map((s: any) => <option key={s.name} value={s.name}>{s.name} ({s.status})</option>)}
            </select>
          </div>
        </div>
      </div>
      {error && <div className="mt-8"><Alert>{error}</Alert></div>}

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, marginTop: 16 }}>
        <div className="card">
          <div className="card-header">Details</div>
          <div className="card-body">
            <table><tbody>
              <tr style={{ cursor: 'default' }}><td className="text-muted">Stage</td><td>{opp.stage}</td></tr>
              <tr style={{ cursor: 'default' }}><td className="text-muted">Amount</td><td>{opp.currency} {Number(opp.amount).toLocaleString()}</td></tr>
              {typeFields.map(f => (
                <tr key={f.schema_name} style={{ cursor: 'default' }}>
                  <td className="text-muted">{f.label}</td>
                  <td>{Array.isArray(opp.fields?.[f.schema_name]) ? opp.fields[f.schema_name].join(', ') : (opp.fields?.[f.schema_name] ?? '—')}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        </div>

        <div className="card">
          <div className="card-header">Activity on this Opportunity</div>
          <div className="card-body">
            {activities === null ? <Loading /> : activities.length === 0 ? <p className="text-muted">No activities logged on this opportunity yet.</p> : activities.map(a => (
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
          </div>
        </div>

        <div className="card" style={{ gridColumn: '2 / 3' }}>
          <div className="card-header">Change History</div>
          <div className="card-body"><AuditTimeline opportunityId={id!} /></div>
        </div>
      </div>

      {showLog && <LogOppActivityModal opportunityId={id!} types={activityTypes} onClose={() => setShowLog(false)}
        onLogged={() => { setShowLog(false); loadActivities(); }} />}
    </div>
  );
}

function LogOppActivityModal({ opportunityId, types, onClose, onLogged }: { opportunityId: string; types: any[]; onClose: () => void; onLogged: () => void }) {
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
      await api.post('/v1/activities', {
        opportunityId, typeId, note,
        fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v !== null && v !== undefined)),
      });
      onLogged();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Log Activity on Opportunity" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Log Activity'}</button>
    </>}>
      {error && <Alert>{error}</Alert>}
      <Field label="Activity type">
        <select value={typeId} onChange={e => setTypeId(e.target.value)}>
          {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      <DynamicFields defs={typeFields} values={fields} onChange={(k, v) => setFields(f => ({ ...f, [k]: v }))} />
      <Field label="Note"><textarea rows={3} value={note} onChange={e => setNote(e.target.value)} /></Field>
    </Modal>
  );
}
