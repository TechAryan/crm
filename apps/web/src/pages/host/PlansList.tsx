import React, { useEffect, useState } from 'react';
import { hostApi } from '../../api';
import { Loading } from '../../ui';

export default function PlansList() {
  const [plans, setPlans] = useState<any[] | null>(null);
  useEffect(() => { hostApi.get('/host/api/plans').then(d => setPlans(d.items)); }, []);

  return (
    <div>
      <div className="page-header"><div><h1>Plans</h1><p>Pricing tiers available to tenants</p></div></div>
      <div className="card">
        {plans === null ? <Loading /> : (
          <table>
            <thead><tr><th>Name</th><th>Code</th><th>Max Users</th><th>API Daily Quota</th><th>Rate Limit</th></tr></thead>
            <tbody>{plans.map(p => (
              <tr key={p.id}><td>{p.name}</td><td className="mono">{p.code}</td><td>{p.max_users}</td>
                <td>{p.api_daily_quota.toLocaleString()}/day</td><td>{p.api_rate_per_sec}/sec</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
