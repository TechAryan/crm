import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { requireScope } from '../auth.js';
import { validateCustomFields, captureLead, postActivity } from '../services.js';
import { audit } from '../audit.js';
import { emitEvent } from '../webhooks.js';
import { resolveVisibleOwnerIds, applyWritePolicy } from '../permissions.js';
import { runAutomations } from '../automation.js';

export const opportunitiesRouter = Router();

function checkPerm(req: any, action: 'view' | 'create' | 'edit' | 'delete') {
  const p = req.auth.perms.opportunity;
  const v = p[action];
  if (action === 'create') { if (!v) throw err(403, 'FORBIDDEN', 'No permission to create opportunities'); return; }
  if (!v || v === false) throw err(403, 'FORBIDDEN', `No permission to ${action} opportunities`);
  return v;
}

function ownerVisible(visibleIds: string[] | null, ownerId: string | null): boolean {
  return visibleIds === null || (!!ownerId && visibleIds.includes(ownerId));
}

opportunitiesRouter.get('/', requireScope('opportunities:read'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'view');
    const rows = await withTenant(req.auth!.tenantId, async c => {
      const params: any[] = [];
      const clauses = ['o.deleted_at IS NULL'];
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      if (visibleIds) { params.push(visibleIds); clauses.push(`o.owner_id = ANY($${params.length})`); }
      if (req.query.status) { params.push(req.query.status); clauses.push(`o.status = $${params.length}`); }
      if (req.query.leadId) { params.push(req.query.leadId); clauses.push(`o.lead_id = $${params.length}`); }
      const r = await c.query(
        `SELECT o.*, ot.name AS type_name FROM opportunities o JOIN opportunity_types ot ON ot.id=o.opportunity_type_id
         WHERE ${clauses.join(' AND ')} ORDER BY o.created_at DESC LIMIT 200`, params);
      return r.rows;
    });
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

opportunitiesRouter.post('/', requireScope('opportunities:write'), async (req, res) => {
  try {
    checkPerm(req, 'create');
    const { leadId, opportunityTypeId, name, amount = 0, currency = 'INR', expectedClose, ownerId, stage, fields = {}, lead } = req.body || {};
    if (!opportunityTypeId || !name) throw err(400, 'MISSING_FIELDS', 'opportunityTypeId, name required');
    const result = await withTenant(req.auth!.tenantId, async c => {
      let finalLeadId = leadId;
      if (!finalLeadId && lead) {
        const cap = await captureLead(c, req.auth!.tenantId, lead, { id: req.auth!.userId, type: req.auth!.actorType });
        finalLeadId = cap.lead.id;
      }
      if (!finalLeadId) throw err(400, 'MISSING_FIELDS', 'leadId or lead required');
      await validateCustomFields(c, `opportunity_type:${opportunityTypeId}`, fields);
      const type = (await c.query(`SELECT stages FROM opportunity_types WHERE id=$1`, [opportunityTypeId])).rows[0];
      if (!type) throw err(400, 'UNKNOWN_TYPE', 'Unknown opportunity type');
      const stages: any[] = type.stages;
      const firstStage = stage ? stages.find(s => s.name === stage) : stages[0];
      if (!firstStage) throw err(400, 'UNKNOWN_STAGE', `Unknown stage: ${stage}`);
      const r = await c.query(
        `INSERT INTO opportunities (tenant_id, lead_id, opportunity_type_id, name, status, stage, amount, currency, expected_close, owner_id, fields, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.auth!.tenantId, finalLeadId, opportunityTypeId, name, firstStage.status, firstStage.name, amount, currency, expectedClose || null, ownerId || req.auth!.userId, JSON.stringify(fields), req.auth!.userId]);
      const opp = r.rows[0];
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'opportunity.created', 'opportunity', opp.id, null, opp);
      await emitEvent(c, req.auth!.tenantId, 'opportunity.created', { opportunity: opp });
      return opp;
    });
    res.status(201).json(result);
  } catch (e) { sendError(res, e); }
});

opportunitiesRouter.patch('/:id', requireScope('opportunities:write'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'edit');
    const channel: 'manual' | 'api' = req.auth!.actorType === 'api_key' ? 'api' : 'manual';
    const policed = applyWritePolicy(req.body || {}, req.auth!.perms.opportunity, channel);
    const { stage, amount, ownerId, fields } = policed.body;
    const result = await withTenant(req.auth!.tenantId, async c => {
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      const cur = (await c.query(`SELECT * FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'Opportunity not found');
      if (!ownerVisible(visibleIds, cur.owner_id)) throw err(403, 'FORBIDDEN', 'Not your opportunity');
      let status = cur.status;
      let stageName: string | null = null;
      if (stage) {
        const type = (await c.query(`SELECT stages FROM opportunity_types WHERE id=$1`, [cur.opportunity_type_id])).rows[0];
        const s = type.stages.find((x: any) => x.name === stage);
        if (!s) throw err(400, 'UNKNOWN_STAGE', `Unknown stage: ${stage}`);
        status = s.status; stageName = s.name;
      }
      const mergedFields = fields ? { ...cur.fields, ...fields } : cur.fields;
      const r = await c.query(
        `UPDATE opportunities SET stage=COALESCE($2,stage), status=$3, amount=COALESCE($4,amount),
         owner_id=COALESCE($5,owner_id), fields=$6, updated_at=now() WHERE id=$1 RETURNING *`,
        [req.params.id, stage, status, amount, ownerId, JSON.stringify(mergedFields)]);
      const after = r.rows[0];
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'opportunity.updated', 'opportunity', after.id, cur, after);
      if (cur.stage !== after.stage) {
        await postActivity(c, req.auth!.tenantId, {
          leadId: after.lead_id, opportunityId: after.id, typeName: 'Stage Changed',
          note: `Opportunity "${after.name}" stage changed from ${cur.stage} to ${stageName || after.stage}`, performedBy: req.auth!.userId,
        }).catch(() => {});
        await emitEvent(c, req.auth!.tenantId, 'opportunity.stage_changed', { opportunity: after, from: cur.stage, to: after.stage });
      }
      if (cur.owner_id !== after.owner_id) {
        const [oldOwner, newOwner] = await Promise.all([
          cur.owner_id ? c.query(`SELECT first_name, last_name FROM users WHERE id=$1`, [cur.owner_id]) : null,
          after.owner_id ? c.query(`SELECT first_name, last_name FROM users WHERE id=$1`, [after.owner_id]) : null,
        ]);
        const name = (r: any) => r?.rows?.[0] ? `${r.rows[0].first_name} ${r.rows[0].last_name || ''}`.trim() : 'Unassigned';
        await postActivity(c, req.auth!.tenantId, {
          leadId: after.lead_id, opportunityId: after.id, typeName: 'Owner Changed',
          note: `Opportunity "${after.name}" owner changed from ${name(oldOwner)} to ${name(newOwner)}`, performedBy: req.auth!.userId,
        }).catch(() => {});
      }
      await runAutomations(c, req.auth!.tenantId, {
        entity: 'opportunity',
        event: cur.stage !== after.stage ? 'stage_changed' : 'updated',
        record: after, before: cur,
        changedFields: [
          ...(cur.stage !== after.stage ? ['stage'] : []),
          ...(cur.owner_id !== after.owner_id ? ['owner_id', 'owner'] : []),
          ...(fields ? Object.keys(fields) : []),
        ],
        actorId: req.auth!.userId, actorType: req.auth!.actorType,
      });
      return after;
    });
    res.json(policed.blocked.length ? { ...result, _blockedFields: policed.blocked } : result);
  } catch (e) { sendError(res, e); }
});

opportunitiesRouter.delete('/:id', requireScope('opportunities:delete'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'delete');
    await withTenant(req.auth!.tenantId, async c => {
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      const cur = (await c.query(`SELECT * FROM opportunities WHERE id=$1`, [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'Opportunity not found');
      if (!ownerVisible(visibleIds, cur.owner_id)) throw err(403, 'FORBIDDEN', 'Not your opportunity');
      await c.query(`UPDATE opportunities SET deleted_at=now() WHERE id=$1`, [req.params.id]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'opportunity.deleted', 'opportunity', cur.id, cur, null);
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

// opportunity types management
export const opportunityTypesRouter = Router();
opportunityTypesRouter.get('/', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => (await c.query(`SELECT * FROM opportunity_types WHERE is_active`)).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

opportunityTypesRouter.patch('/:id', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageFields) throw err(403, 'FORBIDDEN', 'Missing settings permission');
    const { name, stages, isActive } = req.body || {};
    if (stages) {
      if (!Array.isArray(stages) || !stages.length) throw err(400, 'INVALID_STAGES', 'stages must be a non-empty array');
      for (const s of stages) {
        if (!s.name || !['Open', 'Won', 'Lost'].includes(s.status)) throw err(400, 'INVALID_STAGES', 'each stage needs name + status Open|Won|Lost');
      }
    }
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`UPDATE opportunity_types SET name=COALESCE($2,name), stages=COALESCE($3,stages), is_active=COALESCE($4,is_active) WHERE id=$1 RETURNING *`,
        [req.params.id, name, stages ? JSON.stringify(stages) : null, isActive])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Opportunity type not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

// per-type custom fields (LSQ-style: each opportunity type has its own field schema)
opportunityTypesRouter.get('/:id/fields', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT * FROM custom_field_defs WHERE entity=$1 AND is_active ORDER BY sort_order`, [`opportunity_type:${req.params.id}`])).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});
opportunityTypesRouter.post('/:id/fields', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageFields) throw err(403, 'FORBIDDEN', 'Missing settings permission');
    const { label, type, options, mandatory = false, unique = false, sortOrder = 100 } = req.body || {};
    if (!label || !type) throw err(400, 'MISSING_FIELDS', 'label, type required');
    const { toSchemaName } = await import('../util.js');
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(
        `INSERT INTO custom_field_defs (tenant_id, entity, schema_name, label, field_type, options, is_mandatory, is_unique, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.auth!.tenantId, `opportunity_type:${req.params.id}`, toSchemaName(label), label, type,
         options ? JSON.stringify(options) : null, mandatory, unique, sortOrder])).rows[0]);
    res.status(201).json(row);
  } catch (e) {
    if ((e as any)?.code === '23505') return sendError(res, err(409, 'FIELD_EXISTS', 'A field with this name already exists'));
    sendError(res, e);
  }
});
opportunityTypesRouter.post('/', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageFields) throw err(403, 'FORBIDDEN', 'Missing settings permission');
    const { name, stages } = req.body || {};
    if (!name) throw err(400, 'MISSING_FIELDS', 'name required');
    const row = await withTenant(req.auth!.tenantId, async c => {
      const r = stages
        ? await c.query(`INSERT INTO opportunity_types (tenant_id, name, stages) VALUES ($1,$2,$3) RETURNING *`,
            [req.auth!.tenantId, name, JSON.stringify(stages)])
        : await c.query(`INSERT INTO opportunity_types (tenant_id, name) VALUES ($1,$2) RETURNING *`,
            [req.auth!.tenantId, name]);
      return r.rows[0];
    });
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});
