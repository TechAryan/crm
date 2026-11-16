import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { requireScope } from '../auth.js';
import { captureLead, validateCustomFields, postActivity, diffFields, ensureUniqueFields } from '../services.js';
import { audit } from '../audit.js';
import { emitEvent } from '../webhooks.js';
import { applyFieldMask, resolveVisibleOwnerIds, applyWritePolicy } from '../permissions.js';
import { runAutomations } from '../automation.js';

export const leadsRouter = Router();

function checkPerm(req: any, action: 'view' | 'create' | 'edit' | 'delete' | 'import' | 'export') {
  const p = req.auth.perms.lead;
  const v = p[action];
  if (action === 'create') { if (!v) throw err(403, 'FORBIDDEN', 'No permission to create leads'); return; }
  if (!v || v === false) throw err(403, 'FORBIDDEN', `No permission to ${action} leads`);
  return v as 'own' | 'team' | 'all';
}

/** true if the caller (per their record scope) may see a record owned by ownerId. */
function ownerVisible(visibleIds: string[] | null, ownerId: string | null): boolean {
  return visibleIds === null || (!!ownerId && visibleIds.includes(ownerId));
}

// LSQ-style advanced filters: JSON array of {field, op, value}.
// field: whitelisted system column or "fields.mx_*" (custom). ops: eq|neq|contains|in|gt|lt|exists
const SYSTEM_FILTER_COLUMNS = new Set(['first_name', 'last_name', 'email', 'phone', 'sub_source', 'score', 'created_at', 'lead_number']);
function buildFilterClauses(rawFilters: string | undefined, params: any[]): string[] {
  if (!rawFilters) return [];
  let conds: any[];
  try { conds = JSON.parse(rawFilters); } catch { throw err(400, 'INVALID_FILTERS', 'filters must be a JSON array'); }
  if (!Array.isArray(conds)) throw err(400, 'INVALID_FILTERS', 'filters must be a JSON array');
  const clauses: string[] = [];
  for (const c of conds.slice(0, 20)) {
    let expr: string;
    if (typeof c.field !== 'string') throw err(400, 'INVALID_FILTERS', 'each filter needs a field');
    if (c.field.startsWith('fields.')) {
      const key = c.field.slice(7);
      if (!/^[a-z0-9_]+$/i.test(key)) throw err(400, 'INVALID_FILTERS', `Bad field name: ${key}`);
      params.push(key);
      expr = `fields->>$${params.length}`;
    } else if (SYSTEM_FILTER_COLUMNS.has(c.field)) {
      expr = c.field;
    } else {
      throw err(400, 'INVALID_FILTERS', `Cannot filter on: ${c.field}`);
    }
    const numeric = c.value !== undefined && c.value !== '' && !isNaN(Number(c.value));
    switch (c.op) {
      case 'eq': params.push(String(c.value)); clauses.push(`lower(${expr}::text) = lower($${params.length})`); break;
      case 'neq': params.push(String(c.value)); clauses.push(`lower(${expr}::text) IS DISTINCT FROM lower($${params.length})`); break;
      case 'contains': params.push(`%${c.value}%`); clauses.push(`${expr}::text ILIKE $${params.length}`); break;
      case 'in': {
        if (!Array.isArray(c.value)) throw err(400, 'INVALID_FILTERS', `'in' needs an array value`);
        params.push(c.value.map(String)); clauses.push(`lower(${expr}::text) = ANY(SELECT lower(unnest($${params.length}::text[])))`); break;
      }
      case 'gt': params.push(c.value); clauses.push(numeric ? `(${expr})::numeric > $${params.length}::numeric` : `${expr}::text > $${params.length}::text`); break;
      case 'lt': params.push(c.value); clauses.push(numeric ? `(${expr})::numeric < $${params.length}::numeric` : `${expr}::text < $${params.length}::text`); break;
      case 'exists': clauses.push(`${expr} IS NOT NULL AND ${expr}::text <> ''`); break;
      default: throw err(400, 'INVALID_FILTERS', `Unknown op: ${c.op}`);
    }
  }
  return clauses;
}

// ---- list / search ----
leadsRouter.get('/', requireScope('leads:read'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'view');
    const page = Math.max(1, parseInt(String(req.query.page || '1')));
    const limit = Math.min(200, parseInt(String(req.query.limit || '25')));
    const stage = req.query.stage as string | undefined;
    const ownerId = req.query.ownerId as string | undefined;
    const q = req.query.q as string | undefined;

    const result = await withTenant(req.auth!.tenantId, async c => {
      const params: any[] = [];
      const clauses: string[] = ['deleted_at IS NULL'];
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      if (visibleIds) { params.push(visibleIds); clauses.push(`owner_id = ANY($${params.length})`); }
      if (stage) { params.push(stage); clauses.push(`stage_id = $${params.length}`); }
      if (ownerId) { params.push(ownerId); clauses.push(`owner_id = $${params.length}`); }
      if (q) { params.push(`%${q}%`); clauses.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`); }
      clauses.push(...buildFilterClauses(req.query.filters as string | undefined, params));
      const where = clauses.join(' AND ');
      const countR = await c.query(`SELECT COUNT(*) FROM leads WHERE ${where}`, params);
      params.push(limit, (page - 1) * limit);
      const dataR = await c.query(
        `SELECT * FROM leads WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return { total: Number(countR.rows[0].count), items: dataR.rows };
    });
    const hidden = req.auth!.perms.lead.fieldRules?.hidden || [];
    res.json({ ...result, page, limit, items: result.items.map((r: any) => applyFieldMask(r, hidden)) });
  } catch (e) { sendError(res, e); }
});

// ---- CSV export (respects scope + advanced filters) ----
function csvCell(v: any): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

leadsRouter.get('/export', requireScope('leads:read'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'view');
    checkPerm(req, 'export'); // must also hold export permission
    const q = req.query.q as string | undefined;
    const stage = req.query.stage as string | undefined;

    const { rows, customDefs } = await withTenant(req.auth!.tenantId, async c => {
      const params: any[] = [];
      const clauses: string[] = ['l.deleted_at IS NULL'];
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      if (visibleIds) { params.push(visibleIds); clauses.push(`l.owner_id = ANY($${params.length})`); }
      if (stage) { params.push(stage); clauses.push(`l.stage_id = $${params.length}`); }
      if (q) { params.push(`%${q}%`); clauses.push(`(l.first_name ILIKE $${params.length} OR l.last_name ILIKE $${params.length} OR l.email ILIKE $${params.length} OR l.phone ILIKE $${params.length})`); }
      clauses.push(...buildFilterClauses(req.query.filters as string | undefined, params));
      const where = clauses.join(' AND ');
      const r = await c.query(
        `SELECT l.*, s.name AS stage_name, src.name AS source_name,
                u.first_name AS owner_first, u.last_name AS owner_last
         FROM leads l
         LEFT JOIN lead_stages s ON s.id = l.stage_id
         LEFT JOIN lead_sources src ON src.id = l.source_id
         LEFT JOIN users u ON u.id = l.owner_id
         WHERE ${where} ORDER BY l.created_at DESC LIMIT 50000`, params);
      const defs = await c.query(
        `SELECT schema_name, label FROM custom_field_defs WHERE entity='lead' AND is_active=true ORDER BY sort_order`);
      return { rows: r.rows, customDefs: defs.rows };
    });

    const hidden = new Set(req.auth!.perms.lead.fieldRules?.hidden || []);
    const sysCols = [
      ['lead_number', 'Lead Number'], ['first_name', 'First Name'], ['last_name', 'Last Name'],
      ['email', 'Email'], ['phone', 'Phone'], ['stage_name', 'Stage'], ['source_name', 'Source'],
      ['score', 'Score'], ['owner', 'Owner'], ['created_at', 'Created At'],
    ].filter(([k]) => !hidden.has(k));
    const cf = customDefs.filter((d: any) => !hidden.has(d.schema_name));

    const header = [...sysCols.map(c => c[1]), ...cf.map((d: any) => d.label)];
    const lines = [header.map(csvCell).join(',')];
    for (const row of rows) {
      const cells: any[] = sysCols.map(([k]) => {
        if (k === 'owner') return [row.owner_first, row.owner_last].filter(Boolean).join(' ');
        return row[k];
      });
      for (const d of cf) cells.push(row.fields?.[d.schema_name]);
      lines.push(cells.map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-export-${Date.now()}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (e) { sendError(res, e); }
});

// ---- bulk update (change owner/stage on many leads) ----
leadsRouter.post('/bulk-update', requireScope('leads:write'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'edit');
    const { ids, patch } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) throw err(400, 'MISSING_FIELDS', 'ids array required');
    if (ids.length > 1000) throw err(400, 'TOO_MANY', 'Max 1000 leads per bulk operation');
    if (!patch || typeof patch !== 'object') throw err(400, 'MISSING_FIELDS', 'patch object required');
    const result = await withTenant(req.auth!.tenantId, async c => {
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      let stageId: string | null = null;
      if (patch.stage) {
        const s = await c.query(`SELECT id FROM lead_stages WHERE name=$1`, [patch.stage]);
        if (!s.rows[0]) throw err(400, 'UNKNOWN_STAGE', `Unknown stage: ${patch.stage}`);
        stageId = s.rows[0].id;
      }
      let updated = 0, skipped = 0;
      for (const id of ids) {
        const cur = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
        if (!cur) { skipped++; continue; }
        if (!ownerVisible(visibleIds, cur.owner_id)) { skipped++; continue; }
        const after = (await c.query(
          `UPDATE leads SET stage_id=COALESCE($2,stage_id), owner_id=COALESCE($3,owner_id),
             updated_by=$4, updated_at=now() WHERE id=$1 RETURNING *`,
          [id, stageId, patch.ownerId || null, req.auth!.userId])).rows[0];
        await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'lead.updated', 'lead', after.id, cur, after);
        if (cur.stage_id !== after.stage_id) await emitEvent(c, req.auth!.tenantId, 'lead.stage_changed', { lead: after, from: cur.stage_id, to: after.stage_id });
        if (cur.owner_id !== after.owner_id) await emitEvent(c, req.auth!.tenantId, 'lead.owner_changed', { lead: after, newOwnerId: after.owner_id });
        updated++;
      }
      return { updated, skipped };
    });
    res.json({ status: 'Success', ...result });
  } catch (e) { sendError(res, e); }
});

// ---- bulk delete (soft) ----
leadsRouter.post('/bulk-delete', requireScope('leads:delete'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'delete');
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) throw err(400, 'MISSING_FIELDS', 'ids array required');
    if (ids.length > 1000) throw err(400, 'TOO_MANY', 'Max 1000 leads per bulk operation');
    const result = await withTenant(req.auth!.tenantId, async c => {
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      let deleted = 0, skipped = 0;
      for (const id of ids) {
        const cur = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
        if (!cur) { skipped++; continue; }
        if (!ownerVisible(visibleIds, cur.owner_id)) { skipped++; continue; }
        await c.query(`UPDATE leads SET deleted_at=now() WHERE id=$1`, [id]);
        await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'lead.deleted', 'lead', cur.id, cur, null);
        await emitEvent(c, req.auth!.tenantId, 'lead.deleted', { leadId: cur.id });
        deleted++;
      }
      return { deleted, skipped };
    });
    res.json({ status: 'Success', ...result });
  } catch (e) { sendError(res, e); }
});

// ---- create (manual/API) ----
leadsRouter.post('/', requireScope('leads:write'), async (req, res) => {
  try {
    checkPerm(req, 'create');
    const channel: 'manual' | 'api' = req.auth!.actorType === 'api_key' ? 'api' : 'manual';
    const out = await withTenant(req.auth!.tenantId, async c => {
      const policed = applyWritePolicy(req.body || {}, req.auth!.perms.lead, channel);
      const r = await captureLead(c, req.auth!.tenantId, policed.body, { id: req.auth!.userId, type: req.auth!.actorType });
      await runAutomations(c, req.auth!.tenantId, {
        entity: 'lead', event: r.isCreated ? 'created' : 'updated', record: r.lead,
        actorId: req.auth!.userId, actorType: req.auth!.actorType,
      });
      return r;
    });
    res.status(201).json(out);
  } catch (e) { sendError(res, e); }
});

// ---- capture (upsert, used by connectors too) ----
leadsRouter.post('/capture', requireScope('leads:write'), async (req, res) => {
  try {
    const channel: 'manual' | 'api' = req.auth!.actorType === 'api_key' ? 'api' : 'manual';
    const out = await withTenant(req.auth!.tenantId, async c => {
      const policed = applyWritePolicy(req.body || {}, req.auth!.perms.lead, channel);
      const r = await captureLead(c, req.auth!.tenantId, policed.body, { id: req.auth!.userId, type: req.auth!.actorType });
      await runAutomations(c, req.auth!.tenantId, {
        entity: 'lead', event: r.isCreated ? 'created' : 'updated', record: r.lead,
        actorId: req.auth!.userId, actorType: req.auth!.actorType,
      });
      return r;
    });
    res.status(out.isCreated ? 201 : 200).json({ status: 'Success', lead: out.lead, isCreated: out.isCreated });
  } catch (e) { sendError(res, e); }
});

// ---- get one ----
leadsRouter.get('/:id', requireScope('leads:read'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'view');
    const lead = await withTenant(req.auth!.tenantId, async c => {
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      const r = await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      const row = r.rows[0];
      if (!row) throw err(404, 'NOT_FOUND', 'Lead not found');
      if (!ownerVisible(visibleIds, row.owner_id)) throw err(403, 'FORBIDDEN', 'Not your lead');
      return row;
    });
    res.json(applyFieldMask(lead, req.auth!.perms.lead.fieldRules?.hidden || []));
  } catch (e) { sendError(res, e); }
});

// ---- update ----
leadsRouter.patch('/:id', requireScope('leads:write'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'edit');
    // Channel-aware field write policy: 'manual' for a human UI session, 'api' for an API key.
    const channel: 'manual' | 'api' = req.auth!.actorType === 'api_key' ? 'api' : 'manual';
    const result = await withTenant(req.auth!.tenantId, async c => {
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      const cur = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'Lead not found');
      if (!ownerVisible(visibleIds, cur.owner_id)) throw err(403, 'FORBIDDEN', 'Not your lead');
      const policed = applyWritePolicy(req.body || {}, req.auth!.perms.lead, channel);
      const body = policed.body;
      if (body.fields) await validateCustomFields(c, 'lead', body.fields);
      let stageId = cur.stage_id;
      let stageName: string | null = null;
      if (body.stage) {
        const s = await c.query(`SELECT id, name FROM lead_stages WHERE name=$1`, [body.stage]);
        if (!s.rows[0]) throw err(400, 'UNKNOWN_STAGE', `Unknown stage: ${body.stage}`);
        stageId = s.rows[0].id; stageName = s.rows[0].name;
      }
      const mergedFields = body.fields ? { ...cur.fields, ...body.fields } : cur.fields;
      if (body.fields) await ensureUniqueFields(c, 'lead', mergedFields, cur.id);
      const upd = await c.query(
        `UPDATE leads SET first_name=COALESCE($2,first_name), last_name=COALESCE($3,last_name),
           email=COALESCE($4,email), phone=COALESCE($5,phone), additional_phone=COALESCE($6,additional_phone),
           stage_id=$7, owner_id=COALESCE($8,owner_id), fields=$9, updated_by=$10, updated_at=now() WHERE id=$1 RETURNING *`,
        [req.params.id, body.firstName, body.lastName, body.email, body.phone, body.additionalPhone, stageId, body.ownerId,
         JSON.stringify(mergedFields), req.auth!.userId]);
      const after = upd.rows[0];
      const changed = diffFields(cur, after);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'lead.updated', 'lead', after.id, cur, after);

      // System activities in the Activity History timeline (in addition to the field-level audit log).
      if (cur.stage_id !== after.stage_id) {
        const oldStage = (await c.query(`SELECT name FROM lead_stages WHERE id=$1`, [cur.stage_id])).rows[0]?.name || 'Unassigned';
        await postActivity(c, req.auth!.tenantId, {
          leadId: after.id, typeName: 'Stage Changed', note: `Stage changed from ${oldStage} to ${stageName || after.stage_id}`, performedBy: req.auth!.userId,
        }).catch(() => {});
        await emitEvent(c, req.auth!.tenantId, 'lead.stage_changed', { lead: after, from: cur.stage_id, to: after.stage_id });
      }
      if (cur.owner_id !== after.owner_id) {
        const [oldOwner, newOwner] = await Promise.all([
          cur.owner_id ? c.query(`SELECT first_name, last_name FROM users WHERE id=$1`, [cur.owner_id]) : null,
          after.owner_id ? c.query(`SELECT first_name, last_name FROM users WHERE id=$1`, [after.owner_id]) : null,
        ]);
        const name = (r: any) => r?.rows?.[0] ? `${r.rows[0].first_name} ${r.rows[0].last_name || ''}`.trim() : 'Unassigned';
        await postActivity(c, req.auth!.tenantId, {
          leadId: after.id, typeName: 'Owner Changed', note: `Owner changed from ${name(oldOwner)} to ${name(newOwner)}`, performedBy: req.auth!.userId,
        }).catch(() => {});
        await emitEvent(c, req.auth!.tenantId, 'lead.owner_changed', { lead: after, newOwnerId: after.owner_id });

        // Cascade the owner change onto linked opportunities/tasks, per tenant settings (default true).
        const tSettings = (await c.query(`SELECT settings FROM tenants WHERE id=$1`, [req.auth!.tenantId])).rows[0]?.settings || {};
        if (tSettings.cascadeOwnerToOpportunity !== false) {
          const opps = await c.query(`UPDATE opportunities SET owner_id=$2, updated_at=now() WHERE lead_id=$1 AND deleted_at IS NULL AND owner_id IS DISTINCT FROM $2 RETURNING id`, [after.id, after.owner_id]);
          for (const o of opps.rows) await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'opportunity.updated', 'opportunity', o.id, null, { owner_id: after.owner_id, cascadedFromLead: after.id });
        }
        if (tSettings.cascadeOwnerToTask !== false) {
          const tasksR = await c.query(`UPDATE tasks SET owner_id=$2 WHERE lead_id=$1 AND status != 'done' AND owner_id IS DISTINCT FROM $2 RETURNING id`, [after.id, after.owner_id]);
          for (const t of tasksR.rows) await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'task.updated', 'task', t.id, null, { owner_id: after.owner_id, cascadedFromLead: after.id });
        }
      }
      await emitEvent(c, req.auth!.tenantId, 'lead.updated', { lead: after }, changed);

      // Automation runs last, after the record and its system activities are settled, so rules
      // observe the final state. It never throws — see runAutomations.
      await runAutomations(c, req.auth!.tenantId, {
        entity: 'lead',
        event: cur.stage_id !== after.stage_id ? 'stage_changed' : 'updated',
        record: after, before: cur, changedFields: changed,
        actorId: req.auth!.userId, actorType: req.auth!.actorType,
      });
      return { after, blocked: policed.blocked };
    });
    const masked = applyFieldMask(result.after, req.auth!.perms.lead.fieldRules?.hidden || []);
    // Surface dropped fields rather than silently ignoring them — silent drops are very hard
    // for an integrator to debug.
    res.json(result.blocked.length ? { ...masked, _blockedFields: result.blocked } : masked);
  } catch (e) { sendError(res, e); }
});

// ---- delete (soft) ----
leadsRouter.delete('/:id', requireScope('leads:delete'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'delete');
    await withTenant(req.auth!.tenantId, async c => {
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      const cur = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'Lead not found');
      if (!ownerVisible(visibleIds, cur.owner_id)) throw err(403, 'FORBIDDEN', 'Not your lead');
      await c.query(`UPDATE leads SET deleted_at=now() WHERE id=$1`, [req.params.id]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'lead.deleted', 'lead', cur.id, cur, null);
      await emitEvent(c, req.auth!.tenantId, 'lead.deleted', { leadId: cur.id });
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

// ---- merge ----
leadsRouter.post('/:id/merge', requireScope('leads:write'), async (req, res) => {
  try {
    checkPerm(req, 'edit');
    const { duplicateId, fieldChoices } = req.body || {};
    if (!duplicateId) throw err(400, 'MISSING_FIELDS', 'duplicateId required');
    const result = await withTenant(req.auth!.tenantId, async c => {
      const survivor = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [req.params.id])).rows[0];
      const dup = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [duplicateId])).rows[0];
      if (!survivor || !dup) throw err(404, 'NOT_FOUND', 'Lead not found');
      const merged = { ...survivor, ...(fieldChoices || {}) };
      await c.query(
        `UPDATE leads SET first_name=$2,last_name=$3,email=$4,phone=$5,fields=$6,updated_at=now() WHERE id=$1`,
        [survivor.id, merged.first_name, merged.last_name, merged.email, merged.phone, JSON.stringify({ ...dup.fields, ...survivor.fields, ...(fieldChoices?.fields || {}) })]);
      await c.query(`UPDATE activities SET lead_id=$1 WHERE lead_id=$2`, [survivor.id, dup.id]);
      await c.query(`UPDATE opportunities SET lead_id=$1 WHERE lead_id=$2`, [survivor.id, dup.id]);
      await c.query(`UPDATE tasks SET lead_id=$1 WHERE lead_id=$2`, [survivor.id, dup.id]);
      await c.query(`UPDATE leads SET deleted_at=now() WHERE id=$1`, [dup.id]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'lead.merged', 'lead', survivor.id, { dup: dup.id }, null);
      return (await c.query(`SELECT * FROM leads WHERE id=$1`, [survivor.id])).rows[0];
    });
    res.json(result);
  } catch (e) { sendError(res, e); }
});

// ---- activities on a lead ----
leadsRouter.get('/:id/activities', requireScope('activities:read'), async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(
        `SELECT a.*, at.name AS type_name FROM activities a JOIN activity_types at ON at.id=a.activity_type_id
         WHERE a.lead_id=$1 ORDER BY a.activity_time DESC LIMIT 200`, [req.params.id]);
      return r.rows;
    });
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

leadsRouter.post('/:id/activities', requireScope('activities:write'), async (req, res) => {
  try {
    const p = req.auth!.perms.activity;
    if (!p.create) throw err(403, 'FORBIDDEN', 'No permission to create activities');
    const activity = await withTenant(req.auth!.tenantId, c =>
      postActivity(c, req.auth!.tenantId, { ...req.body, leadId: req.params.id, performedBy: req.auth!.userId }));
    res.status(201).json(activity);
  } catch (e) { sendError(res, e); }
});

// ---- notes ----
leadsRouter.get('/:id/notes', requireScope('leads:read'), async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(
        `SELECT n.*, u.first_name AS author_first, u.last_name AS author_last FROM notes n
         LEFT JOIN users u ON u.id = n.created_by WHERE n.lead_id=$1 ORDER BY n.created_at DESC LIMIT 100`, [req.params.id])).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

leadsRouter.post('/:id/notes', requireScope('leads:write'), async (req, res) => {
  try {
    const { body } = req.body || {};
    if (!body) throw err(400, 'MISSING_FIELDS', 'body required');
    const note = await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(`INSERT INTO notes (tenant_id, lead_id, body, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.auth!.tenantId, req.params.id, body, req.auth!.userId]);
      return r.rows[0];
    });
    res.status(201).json(note);
  } catch (e) { sendError(res, e); }
});
