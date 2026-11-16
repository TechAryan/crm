import type pg from 'pg';

export async function audit(
  client: pg.PoolClient,
  tenantId: string,
  actorId: string | null,
  actorType: string,
  action: string,
  entity: string,
  entityId: string | null,
  before: any = null,
  after: any = null,
  ip: string | null = null
) {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, entity, entity_id, before, after, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [tenantId, actorId, actorType, action, entity, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip]
  );
}
