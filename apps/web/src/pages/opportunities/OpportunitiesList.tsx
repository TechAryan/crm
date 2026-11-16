import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Badge, EmptyState, Loading } from '../../ui';

export default function OpportunitiesList() {
  const nav = useNavigate();
  const [items, setItems] = useState<any[] | null>(null);

  useEffect(() => { api.get('/v1/opportunities').then(d => setItems(d.items)); }, []);

  const columns = ['Open', 'Won', 'Lost'];

  return (
    <div>
      <div className="page-header"><div><h1>Opportunities</h1><p>Pipeline across all leads</p></div></div>
      {items === null ? <Loading /> : items.length === 0 ? (
        <EmptyState title="No opportunities yet" subtitle="Create an opportunity from a lead's detail page once they're qualified." />
      ) : (
        <div className="kanban">
          {columns.map(status => (
            <div className="kanban-col" key={status}>
              <div className="kanban-col-header">{status} <Badge kind="muted">{items.filter(i => i.status === status).length}</Badge></div>
              {items.filter(i => i.status === status).map(o => (
                <div className="kanban-card" key={o.id} onClick={() => nav(`/opportunities/${o.id}`)} style={{ cursor: 'pointer' }}>
                  <div className="name">{o.name}</div>
                  <div className="text-muted">{o.stage} · {o.currency} {o.amount}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
