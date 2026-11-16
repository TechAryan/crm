import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { postActivity, validateCustomFields, ensureUniqueFields, diffFields } from '../services.js';
import { audit } from '../audit.js';
import { emitEvent } from '../webhooks.js';
/**
 * Custom Forms engine (LSQ "Forms & Processes" style):
 * - Admins design forms from lead/opportunity/activity fields with sections,
 *   subheadings, per-field required overrides and show-if rules.
 * - Forms are placed on lead or opportunity detail pages.
 * - On submit: update the lead, update the opportunity, or post an activity of a
 *   chosen type — with value rules (if field X = v then set field Y) applied server-side.
 */
export const formsRouter = Router();
function requireManage(req) {
    if (!req.auth.perms.settings?.manageFields)
        throw err(403, 'FORBIDDEN', 'Missing settings permission: manageFields');
}
formsRouter.get('/', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => {
            const params = [];
            let sql = `SELECT * FROM forms WHERE is_active`;
            if (req.query.entity) {
                params.push(req.query.entity);
                sql += ` AND entity = $1`;
            }
            sql += ` ORDER BY name`;
            return (await c.query(sql, params)).rows;
        });
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
formsRouter.get('/:id', async (req, res) => {
    try {
        const row = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT * FROM forms WHERE id=$1`, [req.params.id])).rows[0]);
        if (!row)
            throw err(404, 'NOT_FOUND', 'Form not found');
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
formsRouter.post('/', async (req, res) => {
    try {
        requireManage(req);
        const { name, entity, definition = { sections: [] }, onSubmit = { action: 'update_lead' } } = req.body || {};
        if (!name || !entity)
            throw err(400, 'MISSING_FIELDS', 'name, entity required');
        if (!['lead', 'opportunity'].includes(entity))
            throw err(400, 'INVALID_ENTITY', 'entity must be lead|opportunity');
        if (!['update_lead', 'update_opportunity', 'post_activity'].includes(onSubmit.action))
            throw err(400, 'INVALID_ACTION', 'onSubmit.action must be update_lead|update_opportunity|post_activity');
        if (onSubmit.action === 'post_activity' && !onSubmit.activityTypeId)
            throw err(400, 'MISSING_FIELDS', 'onSubmit.activityTypeId required for post_activity');
        const row = await withTenant(req.auth.tenantId, async (c) => (await c.query(`INSERT INTO forms (tenant_id, name, entity, definition, on_submit, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.auth.tenantId, name, entity, JSON.stringify(definition), JSON.stringify(onSubmit), req.auth.userId])).rows[0]);
        res.status(201).json(row);
    }
    catch (e) {
        if (e?.code === '23505')
            return sendError(res, err(409, 'FORM_EXISTS', 'A form with this name already exists'));
        sendError(res, e);
    }
});
formsRouter.patch('/:id', async (req, res) => {
    try {
        requireManage(req);
        const { name, definition, onSubmit, isActive } = req.body || {};
        const row = await withTenant(req.auth.tenantId, async (c) => (await c.query(`UPDATE forms SET name=COALESCE($2,name), definition=COALESCE($3,definition),
         on_submit=COALESCE($4,on_submit), is_active=COALESCE($5,is_active) WHERE id=$1 RETURNING *`, [req.params.id, name, definition ? JSON.stringify(definition) : null, onSubmit ? JSON.stringify(onSubmit) : null, isActive])).rows[0]);
        if (!row)
            throw err(404, 'NOT_FOUND', 'Form not found');
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
formsRouter.delete('/:id', async (req, res) => {
    try {
        requireManage(req);
        await withTenant(req.auth.tenantId, async (c) => {
            const r = await c.query(`UPDATE forms SET is_active=false WHERE id=$1 RETURNING id`, [req.params.id]);
            if (!r.rowCount)
                throw err(404, 'NOT_FOUND', 'Form not found');
        });
        res.status(204).send();
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---- submit ----
// Body: { leadId?, opportunityId?, values: { <schemaName|systemField>: value } }
formsRouter.post('/:id/submit', async (req, res) => {
    try {
        const { leadId, opportunityId, values = {} } = req.body || {};
        const result = await withTenant(req.auth.tenantId, async (c) => {
            const form = (await c.query(`SELECT * FROM forms WHERE id=$1 AND is_active`, [req.params.id])).rows[0];
            if (!form)
                throw err(404, 'NOT_FOUND', 'Form not found');
            // apply server-side value rules: if field X op v -> set field Y = value
            const finalValues = { ...values };
            for (const rule of form.definition?.valueRules || []) {
                const cur = finalValues[rule.if?.field];
                const matches = rule.if?.op === 'notEmpty'
                    ? cur !== undefined && cur !== null && cur !== ''
                    : rule.if?.op === 'neq'
                        ? String(cur ?? '').toLowerCase() !== String(rule.if?.value ?? '').toLowerCase()
                        : String(cur ?? '').toLowerCase() === String(rule.if?.value ?? '').toLowerCase();
                if (matches && rule.set?.field)
                    finalValues[rule.set.field] = rule.set.value;
            }
            // enforce required fields from the definition (only for visible/simple cases; showIf-hidden fields skip)
            for (const section of form.definition?.sections || []) {
                for (const item of section.items || []) {
                    if (item.kind !== 'field' || !item.required)
                        continue;
                    if (item.showIf) {
                        const dep = finalValues[item.showIf.field];
                        const visible = item.showIf.op === 'notEmpty'
                            ? dep !== undefined && dep !== null && dep !== ''
                            : String(dep ?? '').toLowerCase() === String(item.showIf.value ?? '').toLowerCase();
                        if (!visible)
                            continue;
                    }
                    const v = finalValues[item.schemaName];
                    if (v === undefined || v === null || v === '')
                        throw err(400, 'MANDATORY_FIELD_MISSING', `${item.label || item.schemaName} is required`, item.schemaName);
                }
            }
            const SYSTEM_LEAD = new Set(['firstName', 'lastName', 'email', 'phone']);
            const action = form.on_submit?.action || 'update_lead';
            if (action === 'update_lead') {
                if (!leadId)
                    throw err(400, 'MISSING_FIELDS', 'leadId required for this form');
                const cur = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [leadId])).rows[0];
                if (!cur)
                    throw err(404, 'NOT_FOUND', 'Lead not found');
                const sys = {};
                const custom = {};
                for (const [k, v] of Object.entries(finalValues))
                    (SYSTEM_LEAD.has(k) ? sys : custom)[k] = v;
                if (Object.keys(custom).length) {
                    await validateCustomFields(c, 'lead', custom);
                    await ensureUniqueFields(c, 'lead', { ...cur.fields, ...custom }, cur.id);
                }
                const merged = { ...cur.fields, ...custom };
                const r = await c.query(`UPDATE leads SET first_name=COALESCE($2,first_name), last_name=COALESCE($3,last_name),
             email=COALESCE($4,email), phone=COALESCE($5,phone), fields=$6, updated_by=$7, updated_at=now()
           WHERE id=$1 RETURNING *`, [leadId, sys.firstName, sys.lastName, sys.email, sys.phone, JSON.stringify(merged), req.auth.userId]);
                const after = r.rows[0];
                await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'lead.updated', 'lead', leadId, cur, after);
                await emitEvent(c, req.auth.tenantId, 'lead.updated', { lead: after }, diffFields(cur, after));
                return { action, lead: after };
            }
            if (action === 'update_opportunity') {
                if (!opportunityId)
                    throw err(400, 'MISSING_FIELDS', 'opportunityId required for this form');
                const cur = (await c.query(`SELECT * FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, [opportunityId])).rows[0];
                if (!cur)
                    throw err(404, 'NOT_FOUND', 'Opportunity not found');
                await validateCustomFields(c, `opportunity_type:${cur.opportunity_type_id}`, finalValues);
                const merged = { ...cur.fields, ...finalValues };
                const r = await c.query(`UPDATE opportunities SET fields=$2, updated_at=now() WHERE id=$1 RETURNING *`, [opportunityId, JSON.stringify(merged)]);
                await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'opportunity.updated', 'opportunity', opportunityId, cur, r.rows[0]);
                return { action, opportunity: r.rows[0] };
            }
            // post_activity
            let finalLeadId = leadId;
            if (!finalLeadId && opportunityId) {
                const opp = (await c.query(`SELECT lead_id FROM opportunities WHERE id=$1`, [opportunityId])).rows[0];
                if (!opp)
                    throw err(404, 'NOT_FOUND', 'Opportunity not found');
                finalLeadId = opp.lead_id;
            }
            if (!finalLeadId)
                throw err(400, 'MISSING_FIELDS', 'leadId or opportunityId required');
            const note = finalValues.__note;
            delete finalValues.__note;
            const activity = await postActivity(c, req.auth.tenantId, {
                leadId: finalLeadId, opportunityId: opportunityId || null,
                typeId: form.on_submit.activityTypeId, note, fields: finalValues, performedBy: req.auth.userId,
            });
            return { action, activity };
        });
        res.status(201).json(result);
    }
    catch (e) {
        sendError(res, e);
    }
});
