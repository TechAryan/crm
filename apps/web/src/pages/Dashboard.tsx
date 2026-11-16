import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Alert, Badge, Loading, errMsg } from '../ui';
import { OnboardingChecklist } from '../components/OnboardingChecklist';
import { HelpButton } from '../components/HelpPanel';

export default function Dashboard() {
  const nav = useNavigate();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [asUserId, setAsUserId] = useState('');

  useEffect(() => {
    setData(null);
    const q = asUserId ? `?asUserId=${asUserId}` : '';
    api.get(`/v1/reports/overview${q}`).then(setData).catch(e => setError(errMsg(e)));
  }, [asUserId]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;

  const won = data.pipeline.find((p: any) => p.status === 'Won');
  const open = data.pipeline.find((p: any) => p.status === 'Open');
  const maxStage = Math.max(1, ...data.byStage.map((s: any) => s.count));
  const maxSource = Math.max(1, ...data.bySource.map((s: any) => s.count));
  const maxTrend = Math.max(1, ...data.trend.map((t: any) => t.count));

  return (
    <div>
      <div className="page-header">
        <div className="flex gap-8" style={{ alignItems: 'center' }}>
          <div><h1>Dashboard</h1><p>Your sales at a glance</p></div>
          <HelpButton topic="dashboard" />
        </div>
        {data.directReports.length > 0 && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="small text-muted">Viewing as</label>
            <select value={asUserId} onChange={e => setAsUserId(e.target.value)}>
              <option value="">Myself &amp; my team</option>
              {data.directReports.map((u: any) => <option key={u.id} value={u.id}>{u.first_name} {u.last_name || ''}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* Guided setup — self-hides once the essentials are done. */}
      <OnboardingChecklist />

      <div className="stat-grid">
        <div className="stat-card"><div className="label">Total Leads</div><div className="value">{data.totals.total}</div></div>
        <div className="stat-card"><div className="label">New (7 days)</div><div className="value">{data.totals.last7}</div></div>
        <div className="stat-card"><div className="label">Open Pipeline</div><div className="value">₹{Number(open?.amount || 0).toLocaleString()}</div></div>
        <div className="stat-card"><div className="label">Won Revenue</div><div className="value">₹{Number(won?.amount || 0).toLocaleString()}</div></div>
        <div className="stat-card"><div className="label">Open Tasks</div><div className="value">{data.taskStats.open}</div></div>
        <div className="stat-card" style={data.taskStats.overdue ? { borderColor: 'var(--danger)' } : {}}>
          <div className="label">Overdue Tasks</div><div className="value" style={data.taskStats.overdue ? { color: 'var(--danger)' } : {}}>{data.taskStats.overdue}</div>
        </div>
      </div>

      <div className="dashboard-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-header">Funnel by Stage</div>
          <div className="card-body">
            {data.byStage.map((s: any) => (
              <div key={s.name} className="mt-8">
                <div className="flex-between small"><span>{s.name} {!s.is_active_stage && <span className="text-muted">(closed)</span>}</span><strong>{s.count}</strong></div>
                <div style={{ background: 'var(--bg)', borderRadius: 4, height: 10, marginTop: 3 }}>
                  <div style={{ width: `${(s.count / maxStage) * 100}%`, background: s.is_active_stage ? 'var(--primary)' : 'var(--text-muted)', height: '100%', borderRadius: 4, minWidth: s.count ? 6 : 0 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">Leads by Source</div>
          <div className="card-body">
            {data.bySource.length === 0 ? <p className="text-muted">No leads yet.</p> : data.bySource.map((s: any) => (
              <div key={s.name} className="mt-8">
                <div className="flex-between small"><span>{s.name}</span><strong>{s.count}</strong></div>
                <div style={{ background: 'var(--bg)', borderRadius: 4, height: 10, marginTop: 3 }}>
                  <div style={{ width: `${(s.count / maxSource) * 100}%`, background: 'var(--success)', height: '100%', borderRadius: 4, minWidth: s.count ? 6 : 0 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">New Leads — last 14 days</div>
          <div className="card-body">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
              {data.trend.map((t: any) => (
                <div key={t.day} title={`${t.day}: ${t.count}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                  <div style={{ height: `${(t.count / maxTrend) * 100}%`, minHeight: t.count ? 4 : 1, background: 'var(--primary)', borderRadius: '3px 3px 0 0', opacity: .85 }} />
                </div>
              ))}
            </div>
            <div className="flex-between small text-muted mt-8"><span>{data.trend[0]?.day?.slice(5)}</span><span>today</span></div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">Pipeline by Status</div>
          <div className="card-body">
            <table>
              <thead><tr><th>Status</th><th>Deals</th><th>Value</th></tr></thead>
              <tbody>
                {['Open', 'Won', 'Lost'].map(st => {
                  const row = data.pipeline.find((p: any) => p.status === st);
                  return (
                    <tr key={st} style={{ cursor: 'default' }}>
                      <td><Badge kind={st === 'Won' ? 'success' : st === 'Lost' ? 'danger' : 'warning'}>{st}</Badge></td>
                      <td>{row?.count || 0}</td><td>₹{Number(row?.amount || 0).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card mt-16">
        <div className="card-header">🔥 Needs Attention — active leads untouched for {data.coldDays}+ days</div>
        {data.cold.length === 0 ? (
          <div className="card-body text-muted">Nothing going cold — every active lead has recent activity. 👍</div>
        ) : (
          <table>
            <thead><tr><th>Lead</th><th>Stage</th><th>Score</th><th>Last Touch</th><th>Contact</th></tr></thead>
            <tbody>
              {data.cold.map((l: any) => (
                <tr key={l.id} onClick={() => nav(`/leads/${l.id}`)}>
                  <td><strong>{`${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email || l.phone}</strong></td>
                  <td><Badge kind="warning">{l.stage}</Badge></td>
                  <td>{l.score}</td>
                  <td className="text-muted">{daysAgo(l.last_touch)} days ago</td>
                  <td className="text-muted small">{l.phone || l.email || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.overdueTasks.length > 0 && (
        <div className="card mt-16">
          <div className="card-header">⏰ Overdue Tasks</div>
          <table>
            <thead><tr><th>Task</th><th>Lead</th><th>Was Due</th></tr></thead>
            <tbody>
              {data.overdueTasks.map((t: any) => (
                <tr key={t.id} onClick={() => t.lead_id && nav(`/leads/${t.lead_id}`)}>
                  <td>{t.name}</td>
                  <td>{`${t.first_name || ''} ${t.last_name || ''}`.trim() || '—'}</td>
                  <td style={{ color: 'var(--danger)' }}>{new Date(t.due_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function daysAgo(d: string): number {
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}
