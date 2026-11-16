import { Router } from 'express';
import crypto from 'node:crypto';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';

export const webhooksRouter = Router();

const EVENTS = [
  'lead.created', 'lead.updated', 'lead.stage_changed', 'lead.owner_changed', 'lead.deleted',
  'activity.created', 'opportunity.created', 'opportunity.updated', 'opportunity.stage_changed',
  'task.created', 'task.completed', 'user.created',
];
export { EVENTS as WEBHOOK_EVENTS };

function requireManage(req: any) {
  if (!req.auth.perms.settings?.manageWebhooks) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageWebhooks');
}

webhooksRouter.get('/', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT id, url, events, custom_headers, filters, is_active, created_at FROM webhook_subscriptions ORDER BY created_at DESC`)).rows);
    res.json({ items: rows, availableEvents: EVENTS });
  } catch (e) { sendError(res, e); }
});

webhooksRouter.post('/', async (req, res) => {
  try {
    requireManage(req);
    const { url, events, customHeaders = {}, filters = {} } = req.body || {};
    if (!url || !events?.length) throw err(400, 'MISSING_FIELDS', 'url, events required');
    for (const e of events) if (!EVENTS.includes(e)) throw err(400, 'INVALID_EVENT', `Unknown event: ${e}`);
    const secret = crypto.randomBytes(24).toString('hex');
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(
        `INSERT INTO webhook_subscriptions (tenant_id, url, events, secret, custom_headers, filters) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.auth!.tenantId, url, events, secret, JSON.stringify(customHeaders), JSON.stringify(filters)])).rows[0]);
    res.status(201).json(row); // secret returned once for the tenant to store
  } catch (e) { sendError(res, e); }
});

webhooksRouter.patch('/:id', async (req, res) => {
  try {
    requireManage(req);
    const { url, events, isActive } = req.body || {};
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`UPDATE webhook_subscriptions SET url=COALESCE($2,url), events=COALESCE($3,events), is_active=COALESCE($4,is_active) WHERE id=$1 RETURNING *`,
        [req.params.id, url, events, isActive])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Subscription not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

webhooksRouter.delete('/:id', async (req, res) => {
  try {
    requireManage(req);
    await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(`DELETE FROM webhook_subscriptions WHERE id=$1 RETURNING id`, [req.params.id]);
      if (!r.rowCount) throw err(404, 'NOT_FOUND', 'Subscription not found');
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

webhooksRouter.get('/:id/deliveries', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT id, event, status, attempts, last_response_code, last_error, created_at FROM webhook_deliveries WHERE subscription_id=$1 ORDER BY id DESC LIMIT 100`, [req.params.id])).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});
