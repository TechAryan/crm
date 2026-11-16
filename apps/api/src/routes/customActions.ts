import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { audit } from '../audit.js';
import { requireFeature } from '../entitlements.js';
import { safeHttpCall } from '../http.js';
import { mergeString, mergeJsonBody, mergeMap, buildMergeContext, availableTokens } from '../merge.js';
import { matches } from '../distribution.js';
import { resolveVisibleOwnerIds } from '../permissions.js';

/**
 * Custom action buttons: admin-defined buttons on lead/opportunity/activity pages that call
 * the tenant's own API with record data merged in.
 *
 * The HTTP call is always made SERVER-side (never from the browser) so that:
 *   - secrets in headers are never exposed to the client,
 *   - there is no CORS problem for the tenant's endpoint,
 *   - every call is SSRF-guarded and logged.
 */
export const customActionsRouter = Router();

function requireManage(req: any) {
  if (!req.auth.perms.settings?.manageRoles)
    throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
}

const ENTITIES = ['lead', 'opportunity', 'activity'];
const TABLE: Record<string, string> = { lead: 'leads', opportunity: 'opportunities', activity: 'activities' };

// Token reference for the settings UI ("click to insert" picker).
customActionsRouter.get('/tokens/:entity', async (req, res) => {
  try {
    if (!ENTITIES.includes(req.params.entity)) throw err(400, 'INVALID_ENTITY', `entity must be ${ENTITIES.join('|')}`);
    const tokens = await withTenant(req.auth!.tenantId, c => availableTokens(c, req.params.entity as any));
    res.json({ items: tokens });
  } catch (e) { sendError(res, e); }
});

// List actions. Non-admins get only the ones they're allowed to see/run (used to render buttons).
customActionsRouter.get('/', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => {
      const params: any[] = [];
      let sql = `SELECT * FROM custom_actions WHERE is_active`;
      if (req.query.entity) { params.push(req.query.entity); sql += ` AND entity = $${params.length}`; }
      sql += ` ORDER BY sort_order, name`;
      return (await c.query(sql, params)).rows;
    });
    const visible = rows.filter((a: any) =>
      !a.required_permission || req.auth!.perms.settings?.[a.required_permission]);
    res.json({ items: visible });
  } catch (e) { sendError(res, e); }
});

customActionsRouter.post('/', requireFeature('custom_actions'), async (req, res) => {
  try {
    requireManage(req);
    const {
      name, entity, placement = 'detail_header', method = 'POST', urlTemplate, headers = {},
      bodyTemplate, confirmText, successMessage, visibleWhen = [], requiredPermission,
      openUrlInNewTab = false, sortOrder = 100,
    } = req.body || {};
    if (!name || !entity || !urlTemplate) throw err(400, 'MISSING_FIELDS', 'name, entity, urlTemplate required');
    if (!ENTITIES.includes(entity)) throw err(400, 'INVALID_ENTITY', `entity must be ${ENTITIES.join('|')}`);
    const row = await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(
        `INSERT INTO custom_actions (tenant_id, name, entity, placement, method, url_template, headers, body_template,
           confirm_text, success_message, visible_when, required_permission, open_url_in_new_tab, sort_order, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [req.auth!.tenantId, name, entity, placement, String(method).toUpperCase(), urlTemplate,
         JSON.stringify(headers), bodyTemplate || null, confirmText || null, successMessage || null,
         JSON.stringify(visibleWhen), requiredPermission || null, openUrlInNewTab, sortOrder, req.auth!.userId]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'custom_action.created', 'custom_action', r.rows[0].id, null, r.rows[0]);
      return r.rows[0];
    });
    res.status(201).json(row);
  } catch (e) {
    if ((e as any)?.code === '23505') return sendError(res, err(409, 'ACTION_EXISTS', 'An action with this name already exists for this entity'));
    sendError(res, e);
  }
});

customActionsRouter.patch('/:id', requireFeature('custom_actions'), async (req, res) => {
  try {
    requireManage(req);
    const b = req.body || {};
    const row = await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(
        `UPDATE custom_actions SET name=COALESCE($2,name), placement=COALESCE($3,placement),
           method=COALESCE($4,method), url_template=COALESCE($5,url_template),
           headers=COALESCE($6,headers), body_template=COALESCE($7,body_template),
           confirm_text=COALESCE($8,confirm_text), success_message=COALESCE($9,success_message),
           visible_when=COALESCE($10,visible_when), required_permission=COALESCE($11,required_permission),
           open_url_in_new_tab=COALESCE($12,open_url_in_new_tab), sort_order=COALESCE($13,sort_order),
           is_active=COALESCE($14,is_active)
         WHERE id=$1 RETURNING *`,
        [req.params.id, b.name, b.placement, b.method ? String(b.method).toUpperCase() : null, b.urlTemplate,
         b.headers ? JSON.stringify(b.headers) : null, b.bodyTemplate, b.confirmText, b.successMessage,
         b.visibleWhen ? JSON.stringify(b.visibleWhen) : null, b.requiredPermission,
         b.openUrlInNewTab, b.sortOrder, b.isActive]);
      return r.rows[0];
    });
    if (!row) throw err(404, 'NOT_FOUND', 'Action not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

customActionsRouter.delete('/:id', async (req, res) => {
  try {
    requireManage(req);
    await withTenant(req.auth!.tenantId, async c => {
      const cur = (await c.query(`SELECT * FROM custom_actions WHERE id=$1`, [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'Action not found');
      await c.query(`DELETE FROM custom_actions WHERE id=$1`, [req.params.id]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'custom_action.deleted', 'custom_action', req.params.id, cur, null);
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

/**
 * Execute an action against one record.
 * Enforces: entitlement, the action's required_permission, and that the caller can actually
 * SEE the record (ownership scope) — otherwise a custom action would become a way to exfiltrate
 * records a user isn't allowed to view.
 */
customActionsRouter.post('/:id/execute', requireFeature('custom_actions'), async (req, res) => {
  try {
    const { recordId } = req.body || {};
    if (!recordId) throw err(400, 'MISSING_FIELDS', 'recordId required');

    const out = await withTenant(req.auth!.tenantId, async c => {
      const action = (await c.query(`SELECT * FROM custom_actions WHERE id=$1 AND is_active`, [req.params.id])).rows[0];
      if (!action) throw err(404, 'NOT_FOUND', 'Action not found');
      if (action.required_permission && !req.auth!.perms.settings?.[action.required_permission])
        throw err(403, 'FORBIDDEN', `This action requires the ${action.required_permission} permission`);

      const entity = action.entity as 'lead' | 'opportunity' | 'activity';
      const perm = (req.auth!.perms as any)[entity];
      if (!perm?.view) throw err(403, 'FORBIDDEN', `No permission to view ${entity}s`);

      const table = TABLE[entity];
      const softDelete = entity !== 'activity';
      const record = (await c.query(
        `SELECT * FROM ${table} WHERE id=$1 ${softDelete ? 'AND deleted_at IS NULL' : ''}`, [recordId])).rows[0];
      if (!record) throw err(404, 'NOT_FOUND', `${entity} not found`);

      // Ownership scope check — same visibility rules as reading the record directly.
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, perm.view);
      const ownerField = entity === 'activity' ? 'performed_by' : 'owner_id';
      if (visibleIds !== null && !(record[ownerField] && visibleIds.includes(record[ownerField])))
        throw err(403, 'FORBIDDEN', `Not your ${entity}`);

      if ((action.visible_when || []).length && !matches(action.visible_when, record))
        throw err(400, 'ACTION_NOT_APPLICABLE', 'This action does not apply to this record');

      const me = (await c.query(`SELECT first_name, last_name, email FROM users WHERE id=$1`, [req.auth!.userId])).rows[0];
      const ctx = await buildMergeContext(c, entity, record, {
        user: me ? { name: `${me.first_name || ''} ${me.last_name || ''}`.trim(), email: me.email } : {},
      });

      const url = mergeString(action.url_template, ctx);

      // "Open in new tab" mode: no server call, just hand the merged URL back to the browser.
      if (action.open_url_in_new_tab) return { mode: 'open_url', url };

      const headers = mergeMap(action.headers, ctx);
      const body = action.body_template ? mergeJsonBody(action.body_template, ctx) : null;
      const result = await safeHttpCall({ method: action.method, url, headers, body });

      await c.query(
        `INSERT INTO outbound_calls (tenant_id, source, source_id, method, url, request_body, response_code, response_body, error, duration_ms, actor_id)
         VALUES ($1,'custom_action',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.auth!.tenantId, action.id, action.method, url, body, result.status,
         result.body.slice(0, 4000), result.error, result.durationMs, req.auth!.userId]);

      return {
        mode: 'http',
        ok: result.ok,
        status: result.status,
        message: result.ok ? (action.success_message || 'Action completed') : `Failed: ${result.error}`,
        response: result.body.slice(0, 2000),
      };
    });

    res.status(out.mode === 'http' && !out.ok ? 502 : 200).json(out);
  } catch (e) { sendError(res, e); }
});
