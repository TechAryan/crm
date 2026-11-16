/**
 * Lead distribution engine.
 * Evaluates active rules in priority order; first matching rule assigns an owner.
 * Strategies: fixed_user | fixed_team | round_robin | weighted_round_robin | least_open
 * Round-robin skips users who are checked out or inactive.
 * Returns assigned userId or null.
 */
export async function distributeLead(client, lead) {
    const { rows: rules } = await client.query(`SELECT * FROM distribution_rules WHERE is_active ORDER BY priority ASC, created_at ASC`);
    for (const rule of rules) {
        if (!matches(rule.conditions || [], lead))
            continue;
        const owner = await assign(client, rule);
        if (owner)
            return owner;
    }
    return null;
}
function getField(lead, path) {
    if (path.startsWith('fields.'))
        return lead.fields?.[path.slice(7)];
    return lead[path];
}
export function matches(conditions, lead) {
    for (const c of conditions) {
        const v = getField(lead, c.field);
        const val = c.value;
        const s = (x) => String(x ?? '').toLowerCase();
        switch (c.op) {
            case 'eq':
                if (s(v) !== s(val))
                    return false;
                break;
            case 'neq':
                if (s(v) === s(val))
                    return false;
                break;
            case 'in':
                if (!Array.isArray(val) || !val.map(s).includes(s(v)))
                    return false;
                break;
            case 'contains':
                if (!s(v).includes(s(val)))
                    return false;
                break;
            case 'exists':
                if (v === undefined || v === null || v === '')
                    return false;
                break;
            default: return false;
        }
    }
    return true; // empty conditions = catch-all
}
async function availableUsers(client, userIds) {
    if (!userIds.length)
        return [];
    const { rows } = await client.query(`SELECT id FROM users WHERE id = ANY($1) AND is_active AND is_checked_in`, [userIds]);
    const avail = new Set(rows.map(r => r.id));
    return userIds.filter(id => avail.has(id)); // preserve configured order
}
async function assign(client, rule) {
    const cfg = rule.strategy_config || {};
    switch (rule.strategy) {
        case 'fixed_user': {
            const ok = await availableUsers(client, [cfg.userId].filter(Boolean));
            return ok[0] || cfg.userId || null; // fixed user gets it even if checked out (fallback)
        }
        case 'fixed_team': {
            const { rows } = await client.query(`SELECT id FROM users WHERE team_id=$1 AND is_active AND is_checked_in ORDER BY id`, [cfg.teamId]);
            if (!rows.length)
                return null;
            const idx = rule.rr_cursor % rows.length;
            await client.query(`UPDATE distribution_rules SET rr_cursor = rr_cursor + 1 WHERE id=$1`, [rule.id]);
            return rows[idx].id;
        }
        case 'round_robin': {
            const pool = await availableUsers(client, cfg.userIds || []);
            if (!pool.length)
                return null;
            const idx = rule.rr_cursor % pool.length;
            await client.query(`UPDATE distribution_rules SET rr_cursor = rr_cursor + 1 WHERE id=$1`, [rule.id]);
            return pool[idx];
        }
        case 'weighted_round_robin': {
            const weights = cfg.weights || {};
            const expanded = [];
            for (const [uid, w] of Object.entries(weights))
                for (let i = 0; i < Math.max(1, w); i++)
                    expanded.push(uid);
            const pool = await availableUsers(client, [...new Set(expanded)]);
            const cycle = expanded.filter(u => pool.includes(u));
            if (!cycle.length)
                return null;
            const idx = rule.rr_cursor % cycle.length;
            await client.query(`UPDATE distribution_rules SET rr_cursor = rr_cursor + 1 WHERE id=$1`, [rule.id]);
            return cycle[idx];
        }
        case 'least_open': {
            const pool = await availableUsers(client, cfg.userIds || []);
            if (!pool.length)
                return null;
            const { rows } = await client.query(`SELECT u.id, COUNT(l.id) AS open_count FROM users u
         LEFT JOIN leads l ON l.owner_id = u.id AND l.deleted_at IS NULL
           AND l.stage_id IN (SELECT id FROM lead_stages WHERE is_active_stage)
         WHERE u.id = ANY($1) GROUP BY u.id ORDER BY open_count ASC, u.id ASC`, [pool]);
            return rows[0]?.id || null;
        }
        default: return null;
    }
}
/**
 * Fallback used once distribution rules have all been tried and none produced an owner.
 * Controlled by tenants.settings.defaultOwnerMode:
 *  - 'user'  -> settings.defaultOwnerUserId
 *  - 'field' -> first matching rule in settings.defaultOwnerFieldRules ({conditions, userId})
 *  - 'system' (default) -> the tenant's System user
 * Falls back to the System user if the configured mode can't resolve anyone.
 */
export async function resolveDefaultOwner(client, tenantId, lead) {
    const t = await client.query(`SELECT settings FROM tenants WHERE id=$1`, [tenantId]);
    const settings = t.rows[0]?.settings || {};
    const mode = settings.defaultOwnerMode || 'system';
    if (mode === 'user' && settings.defaultOwnerUserId) {
        const ok = await availableUsers(client, [settings.defaultOwnerUserId]);
        if (ok[0])
            return ok[0];
    }
    if (mode === 'field' && Array.isArray(settings.defaultOwnerFieldRules)) {
        for (const rule of settings.defaultOwnerFieldRules) {
            if (rule.userId && matches(rule.conditions || [], lead))
                return rule.userId;
        }
    }
    // NOTE: both the tenant's Admin and its dedicated System user have is_system=true (both are
    // undeletable), so we must also filter by role name to land on the actual "System" user here —
    // otherwise this would non-deterministically pick whichever of the two was created first (Admin).
    const sys = await client.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.tenant_id=$1 AND u.is_system=true AND u.is_active=true AND r.name='System'
     ORDER BY u.created_at LIMIT 1`, [tenantId]);
    return sys.rows[0]?.id || null;
}
