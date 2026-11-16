import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { requireScope } from '../auth.js';
import { audit } from '../audit.js';
import { emitEvent } from '../webhooks.js';
import { resolveVisibleOwnerIds } from '../permissions.js';

export const tasksRouter = Router();

function checkPerm(req: any, action: 'view' | 'create' | 'edit' | 'delete') {
  const p = req.auth.perms.task;
  const v = p[action];
  if (action === 'create') { if (!v) throw err(403, 'FORBIDDEN', 'No permission to create tasks'); return; }
  if (!v || v === false) throw err(403, 'FORBIDDEN', `No permission to ${action} tasks`);
  return v;
}

tasksRouter.get('/', requireScope('tasks:read'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'view');
    const rows = await withTenant(req.auth!.tenantId, async c => {
      const params: any[] = [];
      const clauses = ['1=1'];
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      if (visibleIds) { params.push(visibleIds); clauses.push(`owner_id = ANY($${params.length})`); }
      if (req.query.status) { params.push(req.query.status); clauses.push(`status = $${params.length}`); }
      if (req.query.leadId) { params.push(req.query.leadId); clauses.push(`lead_id = $${params.length}`); }
      const r = await c.query(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY due_at ASC NULLS LAST LIMIT 200`, params);
      return r.rows;
    });
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

tasksRouter.post('/', requireScope('tasks:write'), async (req, res) => {
  try {
    checkPerm(req, 'create');
    const { kind = 'todo', name, description, leadId, opportunityId, ownerId, dueAt, endAt } = req.body || {};
    if (!name) throw err(400, 'MISSING_FIELDS', 'name required');
    const row = await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(
        `INSERT INTO tasks (tenant_id, kind, name, description, lead_id, opportunity_id, owner_id, due_at, end_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.auth!.tenantId, kind, name, description || null, leadId || null, opportunityId || null, ownerId || req.auth!.userId, dueAt || null, endAt || null, req.auth!.userId]);
      const task = r.rows[0];
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'task.created', 'task', task.id, null, task);
      await emitEvent(c, req.auth!.tenantId, 'task.created', { task });
      return task;
    });
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

tasksRouter.patch('/:id', requireScope('tasks:write'), async (req, res) => {
  try {
    checkPerm(req, 'edit');
    const { name, status, dueAt, ownerId } = req.body || {};
    const row = await withTenant(req.auth!.tenantId, async c => {
      const cur = (await c.query(`SELECT * FROM tasks WHERE id=$1`, [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'Task not found');
      const r = await c.query(
        `UPDATE tasks SET name=COALESCE($2,name), status=COALESCE($3,status),
         due_at=COALESCE($4,due_at), owner_id=COALESCE($5,owner_id),
         completed_at = CASE WHEN $3='done' THEN now() ELSE completed_at END
         WHERE id=$1 RETURNING *`,
        [req.params.id, name, status, dueAt, ownerId]);
      const after = r.rows[0];
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'task.updated', 'task', after.id, cur, after);
      if (status === 'done') await emitEvent(c, req.auth!.tenantId, 'task.completed', { task: after });
      return after;
    });
    res.json(row);
  } catch (e) { sendError(res, e); }
});

tasksRouter.delete('/:id', requireScope('tasks:delete'), async (req, res) => {
  try {
    checkPerm(req, 'delete');
    await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(`DELETE FROM tasks WHERE id=$1 RETURNING id`, [req.params.id]);
      if (!r.rowCount) throw err(404, 'NOT_FOUND', 'Task not found');
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});
