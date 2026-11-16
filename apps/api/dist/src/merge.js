const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
function lookup(ctx, path) {
    let cur = ctx;
    for (const part of path.split('.')) {
        if (cur === null || cur === undefined)
            return undefined;
        cur = cur[part];
    }
    return cur;
}
function stringify(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'object')
        return JSON.stringify(v);
    return String(v);
}
/** Substitute merge tokens in a plain string. Unknown tokens resolve to '' (never left raw). */
export function mergeString(template, ctx) {
    if (!template)
        return template;
    return template.replace(TOKEN_RE, (_m, path) => stringify(lookup(ctx, path)));
}
/**
 * Substitute tokens for use inside a JSON string body. Escapes the value so an apostrophe,
 * quote or newline in customer data can't break out of the JSON string and corrupt the body.
 */
export function mergeJsonBody(template, ctx) {
    if (!template)
        return template;
    return template.replace(TOKEN_RE, (_m, path) => {
        const raw = stringify(lookup(ctx, path));
        const escaped = JSON.stringify(raw); // yields a quoted string
        return escaped.slice(1, -1); // strip the quotes, keep the escaping
    });
}
/** Merge every value of a header/params map. */
export function mergeMap(map, ctx) {
    const out = {};
    for (const [k, v] of Object.entries(map || {}))
        out[k] = mergeString(String(v), ctx);
    return out;
}
/**
 * Build the merge context for a record. Flattens custom fields to both
 * `lead.fields.mx_x` and the convenience alias `lead.mx_x`, and resolves owner + stage names
 * so templates can use human-readable values instead of raw UUIDs.
 */
export async function buildMergeContext(client, entity, record, extra = {}) {
    const ctx = { ...extra };
    const shaped = { ...record, ...(record?.fields || {}) };
    if (entity === 'lead' || entity === 'opportunity') {
        const ownerId = record?.owner_id;
        if (ownerId) {
            const u = (await client.query(`SELECT id, first_name, last_name, email, phone FROM users WHERE id=$1`, [ownerId])).rows[0];
            if (u)
                ctx.owner = { ...u, name: `${u.first_name || ''} ${u.last_name || ''}`.trim() };
        }
    }
    if (entity === 'lead' && record?.stage_id) {
        const s = (await client.query(`SELECT name FROM lead_stages WHERE id=$1`, [record.stage_id])).rows[0];
        shaped.stage = s?.name || '';
    }
    if (entity === 'lead' && record?.source_id) {
        const s = (await client.query(`SELECT name FROM lead_sources WHERE id=$1`, [record.source_id])).rows[0];
        shaped.source = s?.name || '';
    }
    shaped.full_name = `${record?.first_name || ''} ${record?.last_name || ''}`.trim();
    ctx[entity] = shaped;
    if (!ctx.owner)
        ctx.owner = {};
    ctx.now = new Date().toISOString();
    ctx.today = new Date().toISOString().slice(0, 10);
    return ctx;
}
/**
 * The list of tokens available for a given entity — powers the "click to insert" picker in the
 * UI so admins never have to guess token names (which is the main reason merge features go unused).
 */
export async function availableTokens(client, entity) {
    const out = [];
    const base = {
        lead: [
            ['id', 'Lead ID'], ['lead_number', 'Lead Number'], ['first_name', 'First Name'],
            ['last_name', 'Last Name'], ['full_name', 'Full Name'], ['email', 'Email'],
            ['phone', 'Phone'], ['additional_phone', 'Additional Phone'], ['stage', 'Stage'],
            ['source', 'Source'], ['sub_source', 'Sub Source'], ['score', 'Score'],
            ['created_at', 'Created At'], ['updated_at', 'Updated At'],
        ],
        opportunity: [
            ['id', 'Opportunity ID'], ['name', 'Name'], ['stage', 'Stage'], ['status', 'Status'],
            ['amount', 'Amount'], ['currency', 'Currency'], ['lead_id', 'Lead ID'],
            ['expected_close', 'Expected Close'], ['created_at', 'Created At'],
        ],
        activity: [
            ['id', 'Activity ID'], ['note', 'Note'], ['activity_time', 'Activity Time'],
            ['lead_id', 'Lead ID'], ['opportunity_id', 'Opportunity ID'],
        ],
    };
    for (const [name, label] of base[entity] || [])
        out.push({ token: `{{${entity}.${name}}}`, label, group: 'Standard' });
    const defEntity = entity === 'activity' ? null : entity;
    if (defEntity) {
        const defs = (await client.query(`SELECT schema_name, label FROM custom_field_defs
       WHERE entity=$1 AND is_active AND is_system=false ORDER BY sort_order`, [defEntity])).rows;
        for (const d of defs)
            out.push({ token: `{{${entity}.fields.${d.schema_name}}}`, label: d.label, group: 'Custom Fields' });
    }
    out.push({ token: '{{owner.name}}', label: 'Owner Name', group: 'Owner' });
    out.push({ token: '{{owner.email}}', label: 'Owner Email', group: 'Owner' });
    out.push({ token: '{{owner.phone}}', label: 'Owner Phone', group: 'Owner' });
    out.push({ token: '{{user.name}}', label: 'Acting User Name', group: 'Context' });
    out.push({ token: '{{user.email}}', label: 'Acting User Email', group: 'Context' });
    out.push({ token: '{{now}}', label: 'Current timestamp (ISO)', group: 'Context' });
    out.push({ token: '{{today}}', label: "Today's date", group: 'Context' });
    return out;
}
