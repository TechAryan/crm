import { ApiError } from './util.js';
const SCOPE_RANK = { false: 0, own: 1, team: 2, all: 3 };
const rank = (s) => SCOPE_RANK[String(s)] ?? 0;
const maxScope = (a, b) => (rank(a) >= rank(b) ? a : b);
const emptyEntity = () => ({
    view: false, create: false, edit: false, delete: false, import: false, export: false,
    fieldRules: { hidden: [], readonly: [], readonlyManual: [], readonlyApi: [] },
});
export const emptyPermissions = () => ({
    lead: emptyEntity(), activity: emptyEntity(), opportunity: emptyEntity(), task: emptyEntity(), user: emptyEntity(),
    settings: {}, reports: { view: false },
});
/** Merge permission sets: union of allows; field hidden/readonly lists union (deny wins for fields). */
export function mergePermissions(sets) {
    const out = emptyPermissions();
    const entities = ['lead', 'activity', 'opportunity', 'task', 'user'];
    for (const s of sets) {
        if (!s)
            continue;
        for (const e of entities) {
            const p = s[e];
            if (!p)
                continue;
            const cur = out[e];
            cur.view = maxScope(cur.view, p.view ?? false);
            cur.edit = maxScope(cur.edit, p.edit ?? false);
            cur.delete = maxScope(cur.delete, p.delete ?? false);
            cur.create = cur.create || !!p.create;
            cur.import = cur.import || !!p.import;
            cur.export = cur.export || !!p.export;
            if (p.fieldRules) {
                // Field restrictions are DENY rules, so they union (most restrictive wins) — the
                // opposite of the scope merge above, where the most permissive wins.
                for (const k of ['hidden', 'readonly', 'readonlyManual', 'readonlyApi']) {
                    cur.fieldRules[k] = [...new Set([...(cur.fieldRules[k] || []), ...(p.fieldRules[k] || [])])];
                }
            }
        }
        for (const [k, v] of Object.entries(s.settings || {}))
            out.settings[k] = out.settings[k] || !!v;
        if (s.reports?.view)
            out.reports.view = true;
    }
    return out;
}
/** Load a user's effective permissions (role sets + user sets merged). */
export async function loadPermissions(client, userId, roleId) {
    const { rows } = await client.query(`SELECT ps.permissions FROM permission_sets ps
     WHERE ps.id IN (
       SELECT permission_set_id FROM user_permission_sets WHERE user_id = $1
       UNION
       SELECT permission_set_id FROM role_permission_sets WHERE role_id = $2
     )`, [userId, roleId]);
    return mergePermissions(rows.map(r => r.permissions));
}
/**
 * Resolve which owner/performer ids a caller with the given record scope may see.
 * 'all' -> null (no filtering, caller sees everything). 'own' -> just the caller.
 * 'team' -> the caller plus everyone under them in the manager hierarchy (recursively),
 * unless the tenant has turned hierarchyVisibility off, in which case 'team' behaves like 'own'.
 */
export async function resolveVisibleOwnerIds(client, tenantId, userId, scope) {
    if (scope === 'all')
        return null;
    if (scope !== 'team')
        return [userId];
    const t = await client.query(`SELECT settings FROM tenants WHERE id=$1`, [tenantId]);
    const hierarchyOn = t.rows[0]?.settings?.hierarchyVisibility !== false; // default true
    if (!hierarchyOn)
        return [userId];
    const sub = await client.query(`WITH RECURSIVE subtree AS (
       SELECT id FROM users WHERE id = $1
       UNION ALL
       SELECT u.id FROM users u JOIN subtree s ON u.manager_id = s.id
     ) SELECT id FROM subtree`, [userId]);
    return sub.rows.map((r) => r.id);
}
/**
 * Compute the set of field names this actor may NOT write, for the given channel.
 * `manual` = a human in the UI (actorType 'user'); `api` = an API key / integration.
 */
export function blockedWriteFields(perm, channel) {
    const fr = perm?.fieldRules || {};
    const blocked = new Set([...(fr.readonly || [])]);
    for (const f of (channel === 'manual' ? fr.readonlyManual : fr.readonlyApi) || [])
        blocked.add(f);
    // A hidden field is implicitly non-writable — you cannot edit what you cannot see.
    for (const f of fr.hidden || [])
        blocked.add(f);
    return blocked;
}
/**
 * Enforce the field write policy on an incoming request body.
 *
 * Single choke point for every write path (leads, opportunities, activities, forms, capture,
 * imports, automation). Centralising it is what makes the guarantee trustworthy — the same
 * check scattered across a dozen handlers is how these features grow holes.
 *
 * Returns the sanitised body plus which fields were dropped, so callers can surface a warning
 * instead of silently ignoring input (silent drops are very hard for integrators to debug).
 */
export function applyWritePolicy(body, perm, channel, opts = {}) {
    const blockedSet = blockedWriteFields(perm, channel);
    if (!blockedSet.size)
        return { body, blocked: [] };
    const out = { ...body };
    const dropped = [];
    for (const key of Object.keys(out)) {
        if (key === 'fields')
            continue;
        if (blockedSet.has(key)) {
            delete out[key];
            dropped.push(key);
        }
    }
    if (out.fields && typeof out.fields === 'object') {
        out.fields = { ...out.fields };
        for (const key of Object.keys(out.fields)) {
            if (blockedSet.has(key)) {
                delete out.fields[key];
                dropped.push(key);
            }
        }
    }
    if (dropped.length && opts.strict) {
        throw new ApiError(403, 'FIELD_NOT_WRITABLE', `These fields cannot be updated via ${channel === 'api' ? 'the API' : 'the UI'}: ${dropped.join(', ')}`);
    }
    return { body: out, blocked: dropped };
}
/** Strip hidden fields from an entity row before returning to a user. */
export function applyFieldMask(row, hidden = []) {
    if (!hidden.length)
        return row;
    const clone = { ...row, fields: { ...(row.fields || {}) } };
    for (const h of hidden) {
        if (h in clone)
            delete clone[h];
        if (clone.fields && h in clone.fields)
            delete clone.fields[h];
    }
    return clone;
}
/** Map API-key scopes like "leads:write" onto required permission checks. */
export function scopeAllows(scopes, required) {
    if (scopes.includes('*'))
        return true;
    return scopes.includes(required);
}
