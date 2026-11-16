import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';

export const distributionRouter = Router();

/** Run the distribution sweep immediately — used by "Run distribution now" and by scheduled mode. */
distributionRouter.post('/run-now', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageDistribution && !req.auth!.perms.settings?.manageRoles)
      throw err(403, 'FORBIDDEN', 'Missing settings permission: manageDistribution');
    const { runScheduledDistribution } = await import('../scheduler.js');
    const assigned = await runScheduledDistribution(req.auth!.tenantId);
    res.json({ status: 'Success', assigned });
  } catch (e) { sendError(res, e); }
});

function requireManage(req: any) {
  if (!req.auth.perms.settings?.manageDistribution) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageDistribution');
}

distributionRouter.get('/', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => (await c.query(`SELECT * FROM distribution_rules ORDER BY priority`)).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

distributionRouter.post('/', async (req, res) => {
  try {
    requireManage(req);
    const { name, priority = 100, conditions = [], strategy, strategyConfig = {} } = req.body || {};
    if (!name || !strategy) throw err(400, 'MISSING_FIELDS', 'name, strategy required');
    if (!['fixed_user', 'fixed_team', 'round_robin', 'weighted_round_robin', 'least_open'].includes(strategy))
      throw err(400, 'INVALID_STRATEGY', 'Unknown strategy');
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(
        `INSERT INTO distribution_rules (tenant_id, name, priority, conditions, strategy, strategy_config) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.auth!.tenantId, name, priority, JSON.stringify(conditions), strategy, JSON.stringify(strategyConfig)])).rows[0]);
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

distributionRouter.patch('/:id', async (req, res) => {
  try {
    requireManage(req);
    const { name, priority, isActive, conditions, strategyConfig } = req.body || {};
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(
        `UPDATE distribution_rules SET name=COALESCE($2,name), priority=COALESCE($3,priority), is_active=COALESCE($4,is_active),
         conditions=COALESCE($5,conditions), strategy_config=COALESCE($6,strategy_config) WHERE id=$1 RETURNING *`,
        [req.params.id, name, priority, isActive, conditions ? JSON.stringify(conditions) : null, strategyConfig ? JSON.stringify(strategyConfig) : null])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Rule not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

distributionRouter.delete('/:id', async (req, res) => {
  try {
    requireManage(req);
    await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(`DELETE FROM distribution_rules WHERE id=$1 RETURNING id`, [req.params.id]);
      if (!r.rowCount) throw err(404, 'NOT_FOUND', 'Rule not found');
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});
