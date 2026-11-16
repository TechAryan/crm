import { Router } from 'express';
import { parse } from 'csv-parse/sync';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { requireScope } from '../auth.js';
import { captureLead, postActivity, validateCustomFields } from '../services.js';
import { applyWritePolicy } from '../permissions.js';
import { runAutomations } from '../automation.js';
import { audit } from '../audit.js';
/**
 * Bulk create/update APIs and file import for leads, opportunities and activities.
 *
 * Semantics are consistent across all of them, and match the single-record capture API:
 *   - a unique locator is mandatory (so an integration can never blind-create duplicates);
 *   - found -> update only the supplied fields; not found -> create (unless createIfNotFound=false);
 *   - an opportunity ALWAYS hangs off a lead: the lead is resolved (or created) first;
 *   - if no owner is supplied, ownership falls through to the tenant's distribution rules and
 *     then the configured default owner — the same path a web-form lead takes, so bulk-loaded
 *     records don't end up unassigned and invisible.
 *
 * Rows are processed individually with per-row error capture rather than one big transaction:
 * for a 5,000-row import, failing everything because row 4,999 has a bad date is the wrong
 * behaviour. Callers get a per-row result list.
 */
export const bulkRouter = Router();
const MAX_ROWS = 5000;
/** Resolve (or create) the parent lead for an opportunity/activity row. */
async function resolveOrCreateLead(c, tenantId, spec, actor, allowCreate) {
    const searchBy = spec.searchBy || (spec.leadId ? 'id' : spec.email ? 'email' : 'phone');
    let lead = null;
    if (searchBy === 'id' && (spec.leadId || spec.id)) {
        lead = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [spec.leadId || spec.id])).rows[0];
    }
    else if (searchBy === 'phone' && spec.phone) {
        lead = (await c.query(`SELECT * FROM leads WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`, [spec.phone])).rows[0];
    }
    else if (searchBy === 'email' && spec.email) {
        lead = (await c.query(`SELECT * FROM leads WHERE lower(email)=lower($1) AND deleted_at IS NULL LIMIT 1`, [spec.email])).rows[0];
    }
    else if (searchBy && spec.searchValue) {
        // Any unique custom field, e.g. searchBy: "mx_student_id"
        const def = (await c.query(`SELECT is_unique FROM custom_field_defs WHERE entity='lead' AND schema_name=$1 AND is_active`, [searchBy])).rows[0];
        if (!def)
            throw err(400, 'UNKNOWN_FIELD', `No active lead field named '${searchBy}'`);
        if (!def.is_unique)
            throw err(400, 'FIELD_NOT_UNIQUE', `Lead field '${searchBy}' is not unique, so it cannot be used to match a single lead`);
        lead = (await c.query(`SELECT * FROM leads WHERE fields->>$1 = $2 AND deleted_at IS NULL LIMIT 1`, [searchBy, String(spec.searchValue)])).rows[0];
    }
    if (lead)
        return { lead, created: false };
    if (!allowCreate)
        throw err(404, 'LEAD_NOT_FOUND', 'No matching lead found and lead creation is disabled for this row');
    // Create through captureLead so distribution + default-owner + Lead Captured activity all apply.
    const out = await captureLead(c, tenantId, {
        firstName: spec.firstName, lastName: spec.lastName, email: spec.email, phone: spec.phone,
        fields: spec.leadFields || spec.fields || {},
        source: spec.source || 'Bulk Import',
        ownerId: spec.ownerId,
    }, actor);
    return { lead: out.lead, created: true };
}
// ---------------------------------------------------------------------------
// Bulk leads (JSON)
// ---------------------------------------------------------------------------
bulkRouter.post('/leads', requireScope('leads:write'), async (req, res) => {
    try {
        const perms = req.auth.perms;
        if (!perms.lead.create && !perms.lead.edit)
            throw err(403, 'FORBIDDEN', 'No permission to create or edit leads');
        const { rows, createIfNotFound = true, updateBehavior = 'update' } = req.body || {};
        if (!Array.isArray(rows) || !rows.length)
            throw err(400, 'MISSING_FIELDS', 'rows array required');
        if (rows.length > MAX_ROWS)
            throw err(400, 'TOO_MANY', `Max ${MAX_ROWS} rows per call`);
        const channel = req.auth.actorType === 'api_key' ? 'api' : 'manual';
        const results = await withTenant(req.auth.tenantId, async (c) => {
            const out = [];
            for (let i = 0; i < rows.length; i++) {
                try {
                    const policed = applyWritePolicy(rows[i], perms.lead, channel).body;
                    if (!policed.email && !policed.phone && !policed.leadId && !policed.searchValue)
                        throw err(400, 'MISSING_FIELDS', 'Each row needs a unique locator (email, phone, leadId or searchValue)');
                    if (!createIfNotFound) {
                        const found = await resolveOrCreateLead(c, req.auth.tenantId, policed, { id: req.auth.userId, type: req.auth.actorType }, false);
                        policed.searchBy = 'id';
                        policed.leadId = found.lead.id;
                    }
                    const r = await captureLead(c, req.auth.tenantId, { ...policed, updateBehavior }, { id: req.auth.userId, type: req.auth.actorType });
                    await runAutomations(c, req.auth.tenantId, {
                        entity: 'lead', event: r.isCreated ? 'created' : 'updated', record: r.lead,
                        actorId: req.auth.userId, actorType: req.auth.actorType,
                    });
                    out.push({ row: i, status: r.isCreated ? 'created' : 'updated', id: r.lead.id, ownerId: r.lead.owner_id });
                }
                catch (e) {
                    out.push({ row: i, status: 'error', error: e?.message || 'Unknown error', code: e?.code });
                }
            }
            return out;
        });
        res.status(201).json({
            status: 'Success',
            created: results.filter(r => r.status === 'created').length,
            updated: results.filter(r => r.status === 'updated').length,
            failed: results.filter(r => r.status === 'error').length,
            results,
        });
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---------------------------------------------------------------------------
// Bulk opportunities (JSON) — each needs a lead, resolved or created
// ---------------------------------------------------------------------------
/**
 * Shared opportunity bulk-upsert. Used by both the JSON endpoint and the CSV import so the two
 * paths cannot drift apart in behaviour.
 */
async function bulkUpsertOpportunities(req, opts) {
    const perms = req.auth.perms;
    if (!perms.opportunity.create && !perms.opportunity.edit)
        throw err(403, 'FORBIDDEN', 'No permission to create or edit opportunities');
    const { rows, createLeadIfMissing, createIfNotFound } = opts;
    if (!Array.isArray(rows) || !rows.length)
        throw err(400, 'MISSING_FIELDS', 'rows array required');
    if (rows.length > MAX_ROWS)
        throw err(400, 'TOO_MANY', `Max ${MAX_ROWS} rows per call`);
    const channel = req.auth.actorType === 'api_key' ? 'api' : 'manual';
    return withTenant(req.auth.tenantId, async (c) => {
        const defaultType = (await c.query(`SELECT id, stages FROM opportunity_types WHERE is_active ORDER BY name LIMIT 1`)).rows[0];
        const out = [];
        for (let i = 0; i < rows.length; i++) {
            try {
                const raw = rows[i] || {};
                const policed = applyWritePolicy(raw, perms.opportunity, channel).body;
                // 1. The lead is mandatory — an opportunity always belongs to one.
                const { lead, created: leadCreated } = await resolveOrCreateLead(c, req.auth.tenantId, raw, { id: req.auth.userId, type: req.auth.actorType }, createLeadIfMissing);
                // 2. Resolve the opportunity type + stage.
                const typeId = policed.opportunityTypeId || defaultType?.id;
                if (!typeId)
                    throw err(400, 'MISSING_FIELDS', 'No opportunity type available; pass opportunityTypeId');
                const type = (await c.query(`SELECT stages FROM opportunity_types WHERE id=$1`, [typeId])).rows[0];
                const stages = type?.stages || [];
                let stage = stages[0] || { name: 'New', status: 'Open' };
                if (policed.stage) {
                    const found = stages.find((s) => s.name === policed.stage);
                    if (!found)
                        throw err(400, 'UNKNOWN_STAGE', `Unknown opportunity stage: ${policed.stage}`);
                    stage = found;
                }
                // 3. Find an existing opportunity to update (by id, unique field, or name on this lead).
                let existing = null;
                if (policed.id) {
                    existing = (await c.query(`SELECT * FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, [policed.id])).rows[0];
                }
                else if (policed.searchField && policed.searchFieldValue) {
                    existing = (await c.query(`SELECT * FROM opportunities WHERE lead_id=$1 AND fields->>$2 = $3 AND deleted_at IS NULL LIMIT 1`, [lead.id, policed.searchField, String(policed.searchFieldValue)])).rows[0];
                }
                else if (policed.name) {
                    existing = (await c.query(`SELECT * FROM opportunities WHERE lead_id=$1 AND name=$2 AND deleted_at IS NULL LIMIT 1`, [lead.id, policed.name])).rows[0];
                }
                if (policed.fields)
                    await validateCustomFields(c, `opportunity_type:${typeId}`, policed.fields);
                if (existing) {
                    const merged = policed.fields ? { ...existing.fields, ...policed.fields } : existing.fields;
                    const after = (await c.query(`UPDATE opportunities SET name=COALESCE($2,name), stage=COALESCE($3,stage),
                 status=CASE WHEN $3::text IS NULL THEN status ELSE $4 END,
                 amount=COALESCE($5,amount), owner_id=COALESCE($6,owner_id),
                 expected_close=COALESCE($7,expected_close), fields=$8, updated_at=now()
               WHERE id=$1 RETURNING *`, [existing.id, policed.name || null, policed.stage || null, stage.status,
                        policed.amount ?? null, policed.ownerId || null, policed.expectedClose || null,
                        JSON.stringify(merged)])).rows[0];
                    await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'opportunity.updated', 'opportunity', after.id, existing, after);
                    out.push({ row: i, status: 'updated', id: after.id, leadId: lead.id, leadCreated });
                }
                else {
                    if (!createIfNotFound)
                        throw err(404, 'OPPORTUNITY_NOT_FOUND', 'No matching opportunity and createIfNotFound is false');
                    // Owner falls back to the lead's owner, which itself came from distribution /
                    // default-owner settings — so bulk rows follow the same assignment rules.
                    const created = (await c.query(`INSERT INTO opportunities (tenant_id, lead_id, opportunity_type_id, name, status, stage, amount,
                 currency, expected_close, owner_id, fields, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [req.auth.tenantId, lead.id, typeId,
                        policed.name || `Opportunity for ${lead.first_name || 'lead'}`,
                        stage.status, stage.name, policed.amount || 0, policed.currency || 'INR',
                        policed.expectedClose || null, policed.ownerId || lead.owner_id || null,
                        JSON.stringify(policed.fields || {}), req.auth.userId])).rows[0];
                    await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'opportunity.created', 'opportunity', created.id, null, created);
                    await runAutomations(c, req.auth.tenantId, {
                        entity: 'opportunity', event: 'created', record: created, actorId: req.auth.userId,
                    });
                    out.push({ row: i, status: 'created', id: created.id, leadId: lead.id, leadCreated });
                }
            }
            catch (e) {
                out.push({ row: i, status: 'error', error: e?.message || 'Unknown error', code: e?.code });
            }
        }
        return out;
    });
}
function summarize(results) {
    return {
        status: 'Success',
        created: results.filter(r => r.status === 'created').length,
        updated: results.filter(r => r.status === 'updated').length,
        failed: results.filter(r => r.status === 'error').length,
        results,
    };
}
bulkRouter.post('/opportunities', requireScope('opportunities:write'), async (req, res) => {
    try {
        const { rows, createLeadIfMissing = true, createIfNotFound = true } = req.body || {};
        const results = await bulkUpsertOpportunities(req, { rows, createLeadIfMissing, createIfNotFound });
        res.status(201).json(summarize(results));
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---------------------------------------------------------------------------
// Bulk activities (JSON) — each needs a lead
// ---------------------------------------------------------------------------
bulkRouter.post('/activities', requireScope('activities:write'), async (req, res) => {
    try {
        if (!req.auth.perms.activity.create)
            throw err(403, 'FORBIDDEN', 'No permission to create activities');
        const { rows, createLeadIfMissing = false } = req.body || {};
        if (!Array.isArray(rows) || !rows.length)
            throw err(400, 'MISSING_FIELDS', 'rows array required');
        if (rows.length > MAX_ROWS)
            throw err(400, 'TOO_MANY', `Max ${MAX_ROWS} rows per call`);
        const channel = req.auth.actorType === 'api_key' ? 'api' : 'manual';
        const results = await withTenant(req.auth.tenantId, async (c) => {
            const out = [];
            for (let i = 0; i < rows.length; i++) {
                try {
                    const raw = rows[i] || {};
                    const policed = applyWritePolicy(raw, req.auth.perms.activity, channel).body;
                    const { lead } = await resolveOrCreateLead(c, req.auth.tenantId, raw, { id: req.auth.userId, type: req.auth.actorType }, createLeadIfMissing);
                    const act = await postActivity(c, req.auth.tenantId, {
                        leadId: lead.id, opportunityId: policed.opportunityId || null,
                        typeId: policed.typeId, typeName: policed.typeName, note: policed.note,
                        fields: policed.fields, activityTime: policed.activityTime, performedBy: req.auth.userId,
                    });
                    await runAutomations(c, req.auth.tenantId, {
                        entity: 'activity', event: 'created', record: act,
                        activityTypeId: act.activity_type_id, actorId: req.auth.userId,
                    });
                    out.push({ row: i, status: 'created', id: act.id, leadId: lead.id });
                }
                catch (e) {
                    out.push({ row: i, status: 'error', error: e?.message || 'Unknown error', code: e?.code });
                }
            }
            return out;
        });
        res.status(201).json({
            status: 'Success',
            created: results.filter(r => r.status === 'created').length,
            failed: results.filter(r => r.status === 'error').length,
            results,
        });
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---------------------------------------------------------------------------
// File import for opportunities (CSV) — the lead is resolved or created per row
// ---------------------------------------------------------------------------
bulkRouter.post('/import/opportunities', requireScope('opportunities:write'), async (req, res) => {
    try {
        if (!req.auth.perms.opportunity.create)
            throw err(403, 'FORBIDDEN', 'No permission to create opportunities');
        const { csv, fieldMap, searchBy = 'email', createLeadIfMissing = true, opportunityTypeId } = req.body || {};
        if (!csv || !fieldMap)
            throw err(400, 'MISSING_FIELDS', 'csv and fieldMap required');
        let records;
        try {
            records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
        }
        catch {
            throw err(400, 'INVALID_CSV', 'Could not parse CSV');
        }
        if (records.length > MAX_ROWS)
            throw err(400, 'TOO_MANY', `Max ${MAX_ROWS} rows per import`);
        // Map CSV columns onto lead.* / opportunity.* / fields.* destinations.
        const mapped = records.map(row => {
            const o = { fields: {}, leadFields: {}, searchBy };
            for (const [col, dest] of Object.entries(fieldMap)) {
                const val = row[col];
                if (val === undefined || val === '')
                    continue;
                if (dest.startsWith('lead.fields.'))
                    o.leadFields[dest.slice(12)] = val;
                else if (dest.startsWith('lead.'))
                    o[dest.slice(5)] = val;
                else if (dest.startsWith('fields.'))
                    o.fields[dest.slice(7)] = val;
                else
                    o[dest] = val;
            }
            if (searchBy !== 'email' && searchBy !== 'phone' && searchBy !== 'id')
                o.searchValue = o.leadFields[searchBy] ?? o.fields[searchBy];
            if (opportunityTypeId)
                o.opportunityTypeId = opportunityTypeId;
            return o;
        });
        // Same code path as the JSON endpoint, so file and API imports behave identically.
        const results = await bulkUpsertOpportunities(req, { rows: mapped, createLeadIfMissing, createIfNotFound: true });
        res.status(201).json({ ...summarize(results), totalRows: records.length });
    }
    catch (e) {
        sendError(res, e);
    }
});
