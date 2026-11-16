export async function audit(client, tenantId, actorId, actorType, action, entity, entityId, before = null, after = null, ip = null) {
    await client.query(`INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, entity, entity_id, before, after, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [tenantId, actorId, actorType, action, entity, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip]);
}
