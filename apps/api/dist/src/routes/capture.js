import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { requireScope } from '../auth.js';
import { captureLead, postActivity, validateCustomFields, ensureUniqueFields } from '../services.js';
import { audit } from '../audit.js';
import { emitEvent } from '../webhooks.js';
import { runAutomations } from '../automation.js';
import { applyWritePolicy } from '../permissions.js';
/**
 * Unified capture API — the integration workhorse.
 *
 * One authenticated call can upsert a lead, upsert an opportunity on it, and log an activity,
 * atomically. Built for telephony post-call sync (log the call + move the stage + update the
 * opportunity in one shot) but deliberately exposed as a general public API endpoint, so every
 * integration — website, ads, dialer, custom scripts — uses one consistent, well-tested path
 * instead of us maintaining several near-duplicates.
 *
 * POST /v1/capture
 * {
 *   "lead":        { "searchBy":"phone", "phone":"+91...", "createIfNotFound":true,
 *                    "updateBehavior":"updateEmptyOnly", "fields":{...} },
 *   "opportunity": { "searchBy":"id", "id":"...", "createIfNotFound":false, "stage":"...", "fields":{...} },
 *   "activity":    { "typeName":"Incoming Call", "note":"...", "fields":{...} }
 * }
 *
 * Every section is optional except `lead` (an opportunity/activity must hang off a lead).
 * Field-level write policy is enforced per channel (API keys vs user sessions).
 */
export const captureRouter = Router();
captureRouter.post('/', requireScope('leads:write'), async (req, res) => {
    try {
        const body = req.body || {};
        if (!body.lead && !body.leadId)
            throw err(400, 'MISSING_FIELDS', 'A "lead" object (or leadId) is required');
        const channel = req.auth.actorType === 'api_key' ? 'api' : 'manual';
        const perms = req.auth.perms;
        const result = await withTenant(req.auth.tenantId, async (c) => {
            const out = {};
            // ---------- 1. Lead upsert ----------
            let leadId = body.leadId || null;
            let leadRow = null;
            if (body.lead) {
                if (!perms.lead.create && !perms.lead.edit)
                    throw err(403, 'FORBIDDEN', 'No permission to create or edit leads');
                const spec = { ...body.lead };
                const createIfNotFound = spec.createIfNotFound !== false; // default true
                delete spec.createIfNotFound;
                const policed = applyWritePolicy(spec, perms.lead, channel);
                const leadInput = policed.body;
                // A unique locator is mandatory so we never blind-create duplicates from integrations.
                const hasLocator = leadInput.searchBy
                    ? (leadInput.searchBy === 'id' ? !!(leadInput.leadId || leadInput.id) :
                        leadInput.searchBy === 'phone' ? !!leadInput.phone : !!leadInput.email)
                    : !!(leadInput.email || leadInput.phone);
                if (!hasLocator)
                    throw err(400, 'MISSING_FIELDS', 'Provide a unique locator: phone, email, or searchBy:"id" with leadId');
                if (leadInput.searchBy === 'id' && leadInput.id && !leadInput.leadId)
                    leadInput.leadId = leadInput.id;
                if (!createIfNotFound) {
                    // Look first; only update if it already exists.
                    const existing = await findLead(c, leadInput);
                    if (!existing)
                        throw err(404, 'LEAD_NOT_FOUND', 'No matching lead found and createIfNotFound is false');
                    leadInput.searchBy = 'id';
                    leadInput.leadId = existing.id;
                }
                const cap = await captureLead(c, req.auth.tenantId, leadInput, { id: req.auth.userId, type: req.auth.actorType });
                leadRow = cap.lead;
                leadId = cap.lead.id;
                out.lead = { id: leadId, created: cap.isCreated, blockedFields: policed.blocked };
                await runAutomations(c, req.auth.tenantId, {
                    entity: 'lead', event: cap.isCreated ? 'created' : 'updated', record: cap.lead,
                    actorId: req.auth.userId, actorType: req.auth.actorType,
                });
            }
            else if (leadId) {
                leadRow = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [leadId])).rows[0];
                if (!leadRow)
                    throw err(404, 'NOT_FOUND', 'Lead not found');
            }
            // ---------- 2. Opportunity upsert ----------
            if (body.opportunity) {
                if (!leadId)
                    throw err(400, 'MISSING_FIELDS', 'An opportunity needs a lead');
                const spec = { ...body.opportunity };
                const createIfNotFound = spec.createIfNotFound === true; // default false — safer
                delete spec.createIfNotFound;
                const policed = applyWritePolicy(spec, perms.opportunity, channel);
                const oppInput = policed.body;
                let opp = null;
                if (oppInput.id) {
                    opp = (await c.query(`SELECT * FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, [oppInput.id])).rows[0];
                }
                else if (oppInput.searchBy === 'field' && oppInput.searchField && oppInput.searchValue) {
                    opp = (await c.query(`SELECT * FROM opportunities WHERE lead_id=$1 AND fields->>$2 = $3 AND deleted_at IS NULL LIMIT 1`, [leadId, oppInput.searchField, String(oppInput.searchValue)])).rows[0];
                }
                else if (oppInput.name) {
                    opp = (await c.query(`SELECT * FROM opportunities WHERE lead_id=$1 AND name=$2 AND deleted_at IS NULL LIMIT 1`, [leadId, oppInput.name])).rows[0];
                }
                else {
                    // Default: the lead's most recent open opportunity.
                    opp = (await c.query(`SELECT * FROM opportunities WHERE lead_id=$1 AND deleted_at IS NULL
             ORDER BY (status='Open') DESC, created_at DESC LIMIT 1`, [leadId])).rows[0];
                }
                if (!opp && !createIfNotFound) {
                    out.opportunity = { created: false, updated: false, skipped: 'No matching opportunity and createIfNotFound is false' };
                }
                else if (!opp) {
                    if (!perms.opportunity.create)
                        throw err(403, 'FORBIDDEN', 'No permission to create opportunities');
                    const typeId = oppInput.opportunityTypeId ||
                        (await c.query(`SELECT id FROM opportunity_types WHERE is_active ORDER BY name LIMIT 1`)).rows[0]?.id;
                    if (!typeId)
                        throw err(400, 'MISSING_FIELDS', 'No opportunity type available; pass opportunityTypeId');
                    const type = (await c.query(`SELECT stages FROM opportunity_types WHERE id=$1`, [typeId])).rows[0];
                    const stages = type?.stages || [];
                    let stage = stages[0] || { name: 'New', status: 'Open' };
                    if (oppInput.stage) {
                        const found = stages.find((s) => s.name === oppInput.stage);
                        if (!found)
                            throw err(400, 'UNKNOWN_STAGE', `Unknown opportunity stage: ${oppInput.stage}`);
                        stage = found;
                    }
                    if (oppInput.fields)
                        await validateCustomFields(c, `opportunity_type:${typeId}`, oppInput.fields);
                    await ensureUniqueFields(c, 'opportunity', oppInput.fields || {});
                    const created = (await c.query(`INSERT INTO opportunities (tenant_id, lead_id, opportunity_type_id, name, status, stage, amount, currency, expected_close, owner_id, fields, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [req.auth.tenantId, leadId, typeId, oppInput.name || `Opportunity for ${leadRow?.first_name || 'lead'}`,
                        stage.status, stage.name, oppInput.amount || 0, oppInput.currency || 'INR',
                        oppInput.expectedClose || null, oppInput.ownerId || leadRow?.owner_id || req.auth.userId,
                        JSON.stringify(oppInput.fields || {}), req.auth.userId])).rows[0];
                    await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'opportunity.created', 'opportunity', created.id, null, created);
                    await emitEvent(c, req.auth.tenantId, 'opportunity.created', { opportunity: created });
                    out.opportunity = { id: created.id, created: true, blockedFields: policed.blocked };
                    await runAutomations(c, req.auth.tenantId, { entity: 'opportunity', event: 'created', record: created, actorId: req.auth.userId });
                }
                else {
                    if (!perms.opportunity.edit)
                        throw err(403, 'FORBIDDEN', 'No permission to edit opportunities');
                    let status = opp.status;
                    if (oppInput.stage) {
                        const type = (await c.query(`SELECT stages FROM opportunity_types WHERE id=$1`, [opp.opportunity_type_id])).rows[0];
                        const found = (type?.stages || []).find((s) => s.name === oppInput.stage);
                        if (!found)
                            throw err(400, 'UNKNOWN_STAGE', `Unknown opportunity stage: ${oppInput.stage}`);
                        status = found.status;
                    }
                    if (oppInput.fields)
                        await validateCustomFields(c, `opportunity_type:${opp.opportunity_type_id}`, oppInput.fields);
                    const mergedFields = oppInput.fields ? { ...opp.fields, ...oppInput.fields } : opp.fields;
                    if (oppInput.fields)
                        await ensureUniqueFields(c, 'opportunity', mergedFields, opp.id);
                    const after = (await c.query(`UPDATE opportunities SET name=COALESCE($2,name), stage=COALESCE($3,stage), status=$4,
               amount=COALESCE($5,amount), owner_id=COALESCE($6,owner_id), expected_close=COALESCE($7,expected_close),
               fields=$8, updated_at=now() WHERE id=$1 RETURNING *`, [opp.id, oppInput.name || null, oppInput.stage || null, status, oppInput.amount ?? null,
                        oppInput.ownerId || null, oppInput.expectedClose || null, JSON.stringify(mergedFields)])).rows[0];
                    await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'opportunity.updated', 'opportunity', opp.id, opp, after);
                    if (opp.stage !== after.stage) {
                        await emitEvent(c, req.auth.tenantId, 'opportunity.stage_changed', { opportunity: after, from: opp.stage, to: after.stage });
                        await postActivity(c, req.auth.tenantId, {
                            leadId, opportunityId: after.id, typeName: 'Stage Changed',
                            note: `Opportunity stage changed from ${opp.stage} to ${after.stage}`, performedBy: req.auth.userId,
                        }).catch(() => { });
                    }
                    out.opportunity = { id: after.id, created: false, updated: true, blockedFields: policed.blocked };
                    await runAutomations(c, req.auth.tenantId, {
                        entity: 'opportunity', event: opp.stage !== after.stage ? 'stage_changed' : 'updated',
                        record: after, before: opp, changedFields: opp.stage !== after.stage ? ['stage'] : [],
                        actorId: req.auth.userId,
                    });
                }
            }
            // ---------- 3. Activity ----------
            if (body.activity) {
                if (!leadId)
                    throw err(400, 'MISSING_FIELDS', 'An activity needs a lead');
                if (!perms.activity.create)
                    throw err(403, 'FORBIDDEN', 'No permission to create activities');
                const spec = { ...body.activity };
                const policed = applyWritePolicy(spec, perms.activity, channel);
                const act = await postActivity(c, req.auth.tenantId, {
                    leadId,
                    opportunityId: policed.body.opportunityId || out.opportunity?.id || null,
                    typeId: policed.body.typeId, typeName: policed.body.typeName,
                    note: policed.body.note, fields: policed.body.fields,
                    activityTime: policed.body.activityTime, performedBy: req.auth.userId,
                });
                out.activity = { id: act.id, created: true, blockedFields: policed.blocked };
                await runAutomations(c, req.auth.tenantId, {
                    entity: 'activity', event: 'created', record: act,
                    activityTypeId: act.activity_type_id, actorId: req.auth.userId,
                });
            }
            return out;
        });
        res.status(201).json({ status: 'Success', ...result });
    }
    catch (e) {
        sendError(res, e);
    }
});
async function findLead(c, input) {
    if (input.searchBy === 'id' && input.leadId)
        return (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [input.leadId])).rows[0];
    if (input.searchBy === 'phone' && input.phone)
        return (await c.query(`SELECT * FROM leads WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`, [input.phone])).rows[0];
    if (input.searchBy === 'email' && input.email)
        return (await c.query(`SELECT * FROM leads WHERE lower(email)=lower($1) AND deleted_at IS NULL LIMIT 1`, [input.email])).rows[0];
    if (input.email) {
        const byEmail = (await c.query(`SELECT * FROM leads WHERE lower(email)=lower($1) AND deleted_at IS NULL LIMIT 1`, [input.email])).rows[0];
        if (byEmail)
            return byEmail;
    }
    if (input.phone)
        return (await c.query(`SELECT * FROM leads WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`, [input.phone])).rows[0];
    return null;
}
