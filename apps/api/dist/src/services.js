import { err, normalizePhone } from './util.js';
import { emitEvent } from './webhooks.js';
import { distributeLead, resolveDefaultOwner } from './distribution.js';
import { audit } from './audit.js';
// ---------- validation ----------
export async function validateCustomFields(client, entity, fields, { requireMandatory = false } = {}) {
    const { rows: defs } = await client.query(`SELECT schema_name, label, field_type, options, is_mandatory, options_source FROM custom_field_defs WHERE entity=$1 AND is_active`, [entity]);
    const byName = Object.fromEntries(defs.map((d) => [d.schema_name, d]));
    for (const [k, v] of Object.entries(fields || {})) {
        const def = byName[k];
        if (!def)
            throw err(400, 'UNKNOWN_FIELD', `Unknown custom field: ${k}`, k);
        if (v === null || v === undefined || v === '')
            continue;
        // API-sourced dropdowns are not value-validated on write: doing so would mean an upstream
        // HTTP call on every save (latency + a new failure mode), and the option set can legitimately
        // change between render and submit. The customer's API remains the source of truth.
        const apiSourced = def.options_source === 'api';
        switch (def.field_type) {
            case 'number':
            case 'currency':
                if (isNaN(Number(v)))
                    throw err(400, 'INVALID_FIELD_VALUE', `${def.label} must be a number`, k);
                break;
            case 'boolean':
                if (typeof v !== 'boolean' && !['true', 'false'].includes(String(v)))
                    throw err(400, 'INVALID_FIELD_VALUE', `${def.label} must be boolean`, k);
                break;
            case 'dropdown':
                if (!apiSourced && def.options && !def.options.includes(v))
                    throw err(400, 'INVALID_FIELD_VALUE', `${def.label}: invalid option '${v}'`, k);
                break;
            case 'multiselect':
                if (!Array.isArray(v))
                    throw err(400, 'INVALID_FIELD_VALUE', `${def.label} must be an array`, k);
                if (!apiSourced && def.options)
                    for (const item of v)
                        if (!def.options.includes(item))
                            throw err(400, 'INVALID_FIELD_VALUE', `${def.label}: invalid option '${item}'`, k);
                break;
            case 'date':
            case 'datetime':
                if (isNaN(Date.parse(String(v))))
                    throw err(400, 'INVALID_FIELD_VALUE', `${def.label} must be a valid date`, k);
                break;
        }
    }
    if (requireMandatory) {
        for (const d of defs) {
            if (d.is_mandatory && (fields[d.schema_name] === undefined || fields[d.schema_name] === null || fields[d.schema_name] === ''))
                throw err(400, 'MANDATORY_FIELD_MISSING', `${d.label} is mandatory`, d.schema_name);
        }
    }
}
// ---------- unique custom field enforcement ----------
const UNIQUE_TABLES = {
    lead: { table: 'leads', softDelete: true },
    user: { table: 'users', softDelete: false },
    opportunity: { table: 'opportunities', softDelete: true },
};
/** Enforce is_unique custom field defs: no other row in this tenant may hold the same value. */
export async function ensureUniqueFields(client, entity, fields, excludeId) {
    if (!fields || !Object.keys(fields).length)
        return;
    const { rows: defs } = await client.query(`SELECT schema_name, label FROM custom_field_defs WHERE entity=$1 AND is_active AND is_unique`, [entity]);
    if (!defs.length)
        return;
    const cfg = UNIQUE_TABLES[entity];
    for (const d of defs) {
        const val = fields[d.schema_name];
        if (val === undefined || val === null || val === '')
            continue;
        const params = [d.schema_name, String(val)];
        let sql = `SELECT id FROM ${cfg.table} WHERE fields->>$1 = $2`;
        if (cfg.softDelete)
            sql += ` AND deleted_at IS NULL`;
        if (excludeId) {
            params.push(excludeId);
            sql += ` AND id <> $${params.length}`;
        }
        sql += ` LIMIT 1`;
        const dup = await client.query(sql, params);
        if (dup.rowCount)
            throw err(409, 'UNIQUE_FIELD_VIOLATION', `${d.label} must be unique — '${val}' already exists`, d.schema_name);
    }
}
// ---------- lead numbering ----------
async function nextLeadNumber(client, tenantId) {
    // advisory lock scoped to tenant prevents duplicate numbers under concurrency
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':lead_number'))`, [tenantId]);
    const { rows } = await client.query(`SELECT COALESCE(MAX(lead_number), 0) + 1 AS n FROM leads`);
    return Number(rows[0].n);
}
// ---------- activity posting ----------
export async function postActivity(client, tenantId, opts) {
    let typeRow;
    if (opts.typeId) {
        const r = await client.query(`SELECT * FROM activity_types WHERE id=$1 AND is_active`, [opts.typeId]);
        typeRow = r.rows[0];
    }
    else if (opts.typeName) {
        const r = await client.query(`SELECT * FROM activity_types WHERE name=$1 AND is_active`, [opts.typeName]);
        typeRow = r.rows[0];
    }
    if (!typeRow)
        throw err(400, 'UNKNOWN_ACTIVITY_TYPE', `Unknown activity type: ${opts.typeName || opts.typeId}`);
    if (opts.fields && Object.keys(opts.fields).length)
        await validateCustomFields(client, `activity_type:${typeRow.id}`, opts.fields);
    const { rows } = await client.query(`INSERT INTO activities (tenant_id, lead_id, opportunity_id, activity_type_id, note, fields, activity_time, performed_by)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8) RETURNING *`, [tenantId, opts.leadId, opts.opportunityId || null, typeRow.id, opts.note || null,
        JSON.stringify(opts.fields || {}), opts.activityTime || null, opts.performedBy || null]);
    const activity = rows[0];
    if (typeRow.score !== 0) {
        await client.query(`UPDATE leads SET score = score + $2, updated_at=now() WHERE id=$1`, [opts.leadId, typeRow.score]);
    }
    await emitEvent(client, tenantId, 'activity.created', { activity: { ...activity, typeName: typeRow.name } });
    return { ...activity, type_name: typeRow.name };
}
export async function captureLead(client, tenantId, input, actor) {
    const email = input.email?.trim().toLowerCase() || null;
    const phone = normalizePhone(input.phone);
    if (!input.firstName && !input.lastName && !email && !phone)
        throw err(400, 'MANDATORY_FIELD_MISSING', 'At least one of firstName, lastName, email, phone is required');
    if (input.fields)
        await validateCustomFields(client, 'lead', input.fields);
    // dedupe: explicit searchBy > email > phone
    let existing = null;
    if (input.searchBy === 'id' && input.leadId) {
        existing = (await client.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [input.leadId])).rows[0];
    }
    else if (input.searchBy === 'phone' && phone) {
        existing = (await client.query(`SELECT * FROM leads WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`, [phone])).rows[0];
    }
    else if (input.searchBy === 'email' && email) {
        existing = (await client.query(`SELECT * FROM leads WHERE lower(email)=$1 AND deleted_at IS NULL LIMIT 1`, [email])).rows[0];
    }
    else {
        if (email)
            existing = (await client.query(`SELECT * FROM leads WHERE lower(email)=$1 AND deleted_at IS NULL LIMIT 1`, [email])).rows[0];
        if (!existing && phone)
            existing = (await client.query(`SELECT * FROM leads WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`, [phone])).rows[0];
    }
    // resolve stage & source ids
    let stageId = null;
    if (input.stage) {
        const r = await client.query(`SELECT id FROM lead_stages WHERE name=$1`, [input.stage]);
        if (!r.rows[0])
            throw err(400, 'UNKNOWN_STAGE', `Unknown stage: ${input.stage}`);
        stageId = r.rows[0].id;
    }
    let sourceId = null;
    if (input.source) {
        const r = await client.query(`INSERT INTO lead_sources (tenant_id, name) VALUES ($1,$2)
       ON CONFLICT (tenant_id, name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tenantId, input.source]);
        sourceId = r.rows[0].id;
    }
    if (existing) {
        const behavior = input.updateBehavior || 'update';
        if (behavior === 'doNotUpdate')
            return { lead: existing, isCreated: false };
        const merge = (cur, val) => behavior === 'updateEmptyOnly' ? (cur ?? val) : (val ?? cur);
        const newFields = behavior === 'updateEmptyOnly'
            ? { ...(input.fields || {}), ...(existing.fields || {}) }
            : { ...(existing.fields || {}), ...(input.fields || {}) };
        await ensureUniqueFields(client, 'lead', newFields, existing.id);
        const { rows } = await client.query(`UPDATE leads SET first_name=$2, last_name=$3, email=$4, phone=$5,
        stage_id=COALESCE($6, stage_id), source_id=COALESCE($7, source_id), sub_source=COALESCE($8, sub_source),
        fields=$9, utm = utm || $10::jsonb, consent = consent OR $11, updated_by=$12, updated_at=now()
       WHERE id=$1 RETURNING *`, [existing.id,
            merge(existing.first_name, input.firstName), merge(existing.last_name, input.lastName),
            merge(existing.email, email), merge(existing.phone, phone),
            stageId, sourceId, input.subSource || null,
            JSON.stringify(newFields), JSON.stringify(input.utm || {}), !!input.consent, actor.id]);
        const lead = rows[0];
        await audit(client, tenantId, actor.id, actor.type, 'lead.updated', 'lead', lead.id, existing, lead);
        await emitEvent(client, tenantId, 'lead.updated', { lead }, diffFields(existing, lead));
        return { lead, isCreated: false };
    }
    // create
    if (!stageId) {
        const r = await client.query(`SELECT id FROM lead_stages WHERE is_default LIMIT 1`);
        stageId = r.rows[0]?.id || null;
    }
    await ensureUniqueFields(client, 'lead', input.fields || {});
    const leadNumber = await nextLeadNumber(client, tenantId);
    const { rows } = await client.query(`INSERT INTO leads (tenant_id, lead_number, first_name, last_name, email, phone, stage_id, source_id, sub_source, owner_id, fields, utm, consent, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`, [tenantId, leadNumber, input.firstName || null, input.lastName || null, email, phone,
        stageId, sourceId, input.subSource || null, input.ownerId || null,
        JSON.stringify(input.fields || {}), JSON.stringify(input.utm || {}), !!input.consent, actor.id]);
    let lead = rows[0];
    // system activity: Lead Captured
    await postActivity(client, tenantId, { leadId: lead.id, typeName: 'Lead Captured', note: `Source: ${input.source || 'Manual'}`, performedBy: actor.id }).catch(() => { });
    // distribution: rules first, then the tenant's configured default-owner fallback
    // (system user / a chosen user / per-field rules — see Settings > Default Assignment).
    // If the tenant is in 'scheduled' mode the lead is deliberately left unowned here and the
    // daily sweep in scheduler.ts assigns it.
    const tSettings = (await client.query(`SELECT settings FROM tenants WHERE id=$1`, [tenantId])).rows[0]?.settings || {};
    const scheduledMode = tSettings.distributionMode === 'scheduled';
    if (!lead.owner_id && !input.skipDistribution && !scheduledMode) {
        const ownerId = await distributeLead(client, lead) || await resolveDefaultOwner(client, tenantId, lead);
        if (ownerId) {
            const r2 = await client.query(`UPDATE leads SET owner_id=$2, updated_at=now() WHERE id=$1 RETURNING *`, [lead.id, ownerId]);
            lead = r2.rows[0];
            await emitEvent(client, tenantId, 'lead.owner_changed', { lead, newOwnerId: ownerId });
        }
    }
    await audit(client, tenantId, actor.id, actor.type, 'lead.created', 'lead', lead.id, null, lead);
    await emitEvent(client, tenantId, 'lead.created', { lead });
    return { lead, isCreated: true };
}
export function diffFields(before, after) {
    const changed = [];
    for (const k of ['first_name', 'last_name', 'email', 'phone', 'stage_id', 'source_id', 'owner_id']) {
        if (String(before?.[k] ?? '') !== String(after?.[k] ?? ''))
            changed.push(k);
    }
    const bf = before?.fields || {}, af = after?.fields || {};
    for (const k of new Set([...Object.keys(bf), ...Object.keys(af)])) {
        if (JSON.stringify(bf[k]) !== JSON.stringify(af[k]))
            changed.push(k);
    }
    return changed;
}
