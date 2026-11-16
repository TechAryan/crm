import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { requireScope } from '../auth.js';
import { postActivity, validateCustomFields } from '../services.js';
import { audit } from '../audit.js';
import { resolveVisibleOwnerIds, applyWritePolicy } from '../permissions.js';
import { runAutomations } from '../automation.js';

/**
 * Full activity CRUD. Activities are always linked to a lead; optionally also to an
 * opportunity (posting with only opportunityId resolves the parent lead automatically).
 */
export const activitiesRouter = Router();

function checkPerm(req: any, action: 'view' | 'create' | 'edit' | 'delete') {
  const p = req.auth.perms.activity;
  const v = p[action];
  if (action === 'create') { if (!v) throw err(403, 'FORBIDDEN', 'No permission to create activities'); return; }
  if (!v || v === false) throw err(403, 'FORBIDDEN', `No permission to ${action} activities`);
  return v;
}

function performerVisible(visibleIds: string[] | null, performedBy: string | null): boolean {
  return visibleIds === null || (!!performedBy && visibleIds.includes(performedBy));
}

// ---- list (filter by leadId / opportunityId / typeId) ----
activitiesRouter.get('/', requireScope('activities:read'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'view');
    const rows = await withTenant(req.auth!.tenantId, async c => {
      const params: any[] = [];
      const clauses = ['1=1'];
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      if (visibleIds) { params.push(visibleIds); clauses.push(`a.performed_by = ANY($${params.length})`); }
      if (req.query.leadId) { params.push(req.query.leadId); clauses.push(`a.lead_id = $${params.length}`); }
      if (req.query.opportunityId) { params.push(req.query.opportunityId); clauses.push(`a.opportunity_id = $${params.length}`); }
      if (req.query.typeId) { params.push(req.query.typeId); clauses.push(`a.activity_type_id = $${params.length}`); }
      const limit = Math.min(200, parseInt(String(req.query.limit || '100')));
      params.push(limit);
      const r = await c.query(
        `SELECT a.*, at.name AS type_name FROM activities a
         JOIN activity_types at ON at.id = a.activity_type_id
         WHERE ${clauses.join(' AND ')} ORDER BY a.activity_time DESC LIMIT $${params.length}`, params);
      return r.rows;
    });
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

// ---- get one ----
activitiesRouter.get('/:id', requireScope('activities:read'), async (req, res) => {
  try {
    checkPerm(req, 'view');
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT a.*, at.name AS type_name FROM activities a JOIN activity_types at ON at.id=a.activity_type_id WHERE a.id=$1`, [req.params.id])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Activity not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

// ---- create (leadId and/or opportunityId) ----
// Also accepts optional leadPatch/opportunityPatch ({stage?, ownerId?, fields?}) applied in the
// same call, atomically — built for telephony/call-logging integrations: one API call creates
// an "Incoming Call"/"Outbound Call" activity (with whatever custom fields the tenant added —
// recording URL, duration, disposition, ...) and can update the lead's stage etc. in one shot.
activitiesRouter.post('/', requireScope('activities:write'), async (req, res) => {
  try {
    checkPerm(req, 'create');
    const { leadId, opportunityId, typeId, typeName, note, fields, activityTime, leadPatch, opportunityPatch } = req.body || {};
    if (!leadId && !opportunityId) throw err(400, 'MISSING_FIELDS', 'leadId or opportunityId required');
    const result = await withTenant(req.auth!.tenantId, async c => {
      let finalLeadId = leadId;
      if (!finalLeadId) {
        const opp = (await c.query(`SELECT lead_id FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, [opportunityId])).rows[0];
        if (!opp) throw err(404, 'NOT_FOUND', 'Opportunity not found');
        finalLeadId = opp.lead_id;
      }
      const activity = await postActivity(c, req.auth!.tenantId, {
        leadId: finalLeadId, opportunityId: opportunityId || null, typeId, typeName, note, fields,
        activityTime, performedBy: req.auth!.userId,
      });

      let updatedLead: any, updatedOpportunity: any;
      if (leadPatch && Object.keys(leadPatch).length) {
        if (!req.auth!.perms.lead.edit) throw err(403, 'FORBIDDEN', 'No permission to edit leads');
        const cur = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [finalLeadId])).rows[0];
        if (!cur) throw err(404, 'NOT_FOUND', 'Lead not found');
        let stageId = cur.stage_id;
        if (leadPatch.stage) {
          const s = await c.query(`SELECT id FROM lead_stages WHERE name=$1`, [leadPatch.stage]);
          if (!s.rows[0]) throw err(400, 'UNKNOWN_STAGE', `Unknown stage: ${leadPatch.stage}`);
          stageId = s.rows[0].id;
        }
        if (leadPatch.fields) await validateCustomFields(c, 'lead', leadPatch.fields);
        const mergedFields = leadPatch.fields ? { ...cur.fields, ...leadPatch.fields } : cur.fields;
        const upd = await c.query(
          `UPDATE leads SET stage_id=$2, owner_id=COALESCE($3,owner_id), fields=$4, updated_by=$5, updated_at=now() WHERE id=$1 RETURNING *`,
          [finalLeadId, stageId, leadPatch.ownerId || null, JSON.stringify(mergedFields), req.auth!.userId]);
        updatedLead = upd.rows[0];
        await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'lead.updated', 'lead', updatedLead.id, cur, updatedLead);
      }
      if (opportunityPatch && Object.keys(opportunityPatch).length && opportunityId) {
        if (!req.auth!.perms.opportunity.edit) throw err(403, 'FORBIDDEN', 'No permission to edit opportunities');
        const cur = (await c.query(`SELECT * FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, [opportunityId])).rows[0];
        if (cur) {
          let status = cur.status;
          if (opportunityPatch.stage) {
            const type = (await c.query(`SELECT stages FROM opportunity_types WHERE id=$1`, [cur.opportunity_type_id])).rows[0];
            const s = type.stages.find((x: any) => x.name === opportunityPatch.stage);
            if (!s) throw err(400, 'UNKNOWN_STAGE', `Unknown stage: ${opportunityPatch.stage}`);
            status = s.status;
          }
          const mergedFields = opportunityPatch.fields ? { ...cur.fields, ...opportunityPatch.fields } : cur.fields;
          const upd = await c.query(
            `UPDATE opportunities SET stage=COALESCE($2,stage), status=$3, owner_id=COALESCE($4,owner_id), fields=$5, updated_at=now() WHERE id=$1 RETURNING *`,
            [opportunityId, opportunityPatch.stage || null, status, opportunityPatch.ownerId || null, JSON.stringify(mergedFields)]);
          updatedOpportunity = upd.rows[0];
          await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'opportunity.updated', 'opportunity', updatedOpportunity.id, cur, updatedOpportunity);
        }
      }
      await runAutomations(c, req.auth!.tenantId, {
        entity: 'activity', event: 'created', record: activity,
        activityTypeId: activity.activity_type_id,
        actorId: req.auth!.userId, actorType: req.auth!.actorType,
      });
      if (updatedLead) {
        await runAutomations(c, req.auth!.tenantId, {
          entity: 'lead', event: 'updated', record: updatedLead,
          actorId: req.auth!.userId, actorType: req.auth!.actorType,
        });
      }
      return { activity, lead: updatedLead, opportunity: updatedOpportunity };
    });
    res.status(201).json({ ...result.activity, lead: result.lead, opportunity: result.opportunity });
  } catch (e) { sendError(res, e); }
});

// ---- update (note + fields; edits are audited) ----
activitiesRouter.patch('/:id', requireScope('activities:write'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'edit');
    const channel: 'manual' | 'api' = req.auth!.actorType === 'api_key' ? 'api' : 'manual';
    const { note, fields, activityTime } = applyWritePolicy(req.body || {}, req.auth!.perms.activity, channel).body;
    const row = await withTenant(req.auth!.tenantId, async c => {
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      const cur = (await c.query(`SELECT * FROM activities WHERE id=$1`, [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'Activity not found');
      if (!performerVisible(visibleIds, cur.performed_by)) throw err(403, 'FORBIDDEN', 'Not your activity');
      if (fields && Object.keys(fields).length)
        await validateCustomFields(c, `activity_type:${cur.activity_type_id}`, fields);
      const merged = fields ? { ...cur.fields, ...fields } : cur.fields;
      const r = await c.query(
        `UPDATE activities SET note=COALESCE($2,note), fields=$3, activity_time=COALESCE($4,activity_time) WHERE id=$1 RETURNING *`,
        [req.params.id, note, JSON.stringify(merged), activityTime]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'activity.updated', 'activity', cur.id, cur, r.rows[0]);
      return r.rows[0];
    });
    res.json(row);
  } catch (e) { sendError(res, e); }
});

// ---- delete (reverses the lead-score contribution of the activity type) ----
activitiesRouter.delete('/:id', requireScope('activities:delete'), async (req, res) => {
  try {
    const scope = checkPerm(req, 'delete');
    await withTenant(req.auth!.tenantId, async c => {
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, scope);
      const cur = (await c.query(
        `SELECT a.*, at.score AS type_score FROM activities a JOIN activity_types at ON at.id=a.activity_type_id WHERE a.id=$1`,
        [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'Activity not found');
      if (!performerVisible(visibleIds, cur.performed_by)) throw err(403, 'FORBIDDEN', 'Not your activity');
      await c.query(`DELETE FROM activities WHERE id=$1`, [req.params.id]);
      if (cur.type_score !== 0)
        await c.query(`UPDATE leads SET score = score - $2, updated_at=now() WHERE id=$1`, [cur.lead_id, cur.type_score]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'activity.deleted', 'activity', cur.id, cur, null);
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});
