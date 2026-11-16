import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';

export const auditRouter = Router();

// Only admins (manageRoles) may browse the full, unscoped tenant audit trail.
function requireManage(req: any) {
  if (!req.auth.perms.settings?.manageRoles) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
}

/**
 * A record-scoped "History" query (leadId or opportunityId) is allowed for anyone who can
 * already view that record — no admin permission required — because it's just the same
 * audit trail rendered as a timeline on the record's own detail page. Broad, unscoped
 * browsing of the whole tenant's audit log (no leadId/opportunityId/entity+entityId given)
 * still requires manageRoles.
 */
async function checkRecordAccess(req: any, c: any, leadId?: string, opportunityId?: string) {
  if (leadId) {
    const p = req.auth.perms.lead;
    if (!p?.view) throw err(403, 'FORBIDDEN', 'No permission to view leads');
    if (p.view !== 'all') {
      const lead = (await c.query(`SELECT owner_id FROM leads WHERE id=$1`, [leadId])).rows[0];
      if (!lead || lead.owner_id !== req.auth.userId) throw err(403, 'FORBIDDEN', 'Not your lead');
    }
  }
  if (opportunityId) {
    const p = req.auth.perms.opportunity;
    if (!p?.view) throw err(403, 'FORBIDDEN', 'No permission to view opportunities');
    if (p.view !== 'all') {
      const opp = (await c.query(`SELECT owner_id FROM opportunities WHERE id=$1`, [opportunityId])).rows[0];
      if (!opp || opp.owner_id !== req.auth.userId) throw err(403, 'FORBIDDEN', 'Not your opportunity');
    }
  }
}

auditRouter.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1')));
    const limit = Math.min(200, parseInt(String(req.query.limit || '50')));
    const entity = req.query.entity as string | undefined;
    const entityId = req.query.entityId as string | undefined;
    const action = req.query.action as string | undefined;
    const actorId = req.query.actorId as string | undefined;
    const leadId = req.query.leadId as string | undefined;
    const opportunityId = req.query.opportunityId as string | undefined;
    const scoped = !!(leadId || opportunityId);
    if (!scoped) requireManage(req);

    const result = await withTenant(req.auth!.tenantId, async c => {
      if (scoped) await checkRecordAccess(req, c, leadId, opportunityId);

      const params: any[] = [];
      const clauses: string[] = [];
      if (leadId) {
        params.push(leadId);
        clauses.push(`( (a.entity='lead' AND a.entity_id=$${params.length})
          OR (a.entity='activity' AND a.entity_id IN (SELECT id FROM activities WHERE lead_id=$${params.length}))
          OR (a.entity='opportunity' AND a.entity_id IN (SELECT id FROM opportunities WHERE lead_id=$${params.length})) )`);
      }
      if (opportunityId) {
        params.push(opportunityId);
        clauses.push(`( (a.entity='opportunity' AND a.entity_id=$${params.length})
          OR (a.entity='activity' AND a.entity_id IN (SELECT id FROM activities WHERE opportunity_id=$${params.length})) )`);
      }
      if (entity) { params.push(entity); clauses.push(`a.entity = $${params.length}`); }
      if (entityId) { params.push(entityId); clauses.push(`a.entity_id = $${params.length}`); }
      if (action) { params.push(`${action}%`); clauses.push(`a.action ILIKE $${params.length}`); }
      if (actorId) { params.push(actorId); clauses.push(`a.actor_id = $${params.length}`); }
      const where = clauses.length ? clauses.join(' AND ') : '1=1';
      const countR = await c.query(`SELECT COUNT(*) FROM audit_log a WHERE ${where}`, params);
      params.push(limit, (page - 1) * limit);
      const rows = await c.query(
        `SELECT a.id, a.actor_id, a.actor_type, a.action, a.entity, a.entity_id, a.ip, a.created_at,
                u.first_name AS actor_first, u.last_name AS actor_last, u.email AS actor_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         WHERE ${where} ORDER BY a.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return { total: Number(countR.rows[0].count), items: rows.rows };
    });
    res.json({ ...result, page, limit });
  } catch (e) { sendError(res, e); }
});

// Full before/after diff for a single entry. Same record-scope rule: pass leadId/opportunityId
// (matching the entry's parent record) to access without the admin permission.
auditRouter.get('/:id', async (req, res) => {
  try {
    const leadId = req.query.leadId as string | undefined;
    const opportunityId = req.query.opportunityId as string | undefined;
    const scoped = !!(leadId || opportunityId);
    if (!scoped) requireManage(req);
    const row = await withTenant(req.auth!.tenantId, async c => {
      if (scoped) await checkRecordAccess(req, c, leadId, opportunityId);
      return (await c.query(`SELECT * FROM audit_log WHERE id=$1`, [req.params.id])).rows[0];
    });
    if (!row) throw err(404, 'NOT_FOUND', 'Audit entry not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});
