import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError, toSchemaName } from '../util.js';
import { safeHttpCall } from '../http.js';
import { assertFeature } from '../entitlements.js';
export const customFieldsRouter = Router();
function requireManage(req) {
    if (!req.auth.perms.settings?.manageFields)
        throw err(403, 'FORBIDDEN', 'Missing settings permission: manageFields');
}
const optionsCache = new Map();
/** Walk a dotted path into the response payload (e.g. "data.items"). */
function atPath(obj, path) {
    if (!path)
        return obj;
    let cur = obj;
    for (const part of path.split('.')) {
        if (cur === null || cur === undefined)
            return undefined;
        cur = cur[part];
    }
    return cur;
}
export async function resolveApiOptions(client, tenantId, def, opts = {}) {
    const cfg = def.options_api || {};
    if (!cfg.url)
        throw err(400, 'INVALID_FIELD_CONFIG', `Field ${def.schema_name} has options_source='api' but no url configured`);
    const cacheKey = `${tenantId}:${def.entity}:${def.schema_name}`;
    const ttl = Math.max(30, Number(cfg.cacheTtlSeconds ?? 300)) * 1000;
    const hit = optionsCache.get(cacheKey);
    if (!opts.force && hit && Date.now() - hit.at < hit.ttl)
        return hit.options;
    const started = Date.now();
    const result = await safeHttpCall({
        method: cfg.method || 'GET', url: cfg.url, headers: cfg.headers || {}, timeoutMs: 8000, maxBytes: 512 * 1024,
    });
    try {
        await client.query(`INSERT INTO outbound_calls (tenant_id, source, method, url, response_code, response_body, error, duration_ms)
       VALUES ($1,'field_options',$2,$3,$4,$5,$6,$7)`, [tenantId, cfg.method || 'GET', cfg.url, result.status, result.body.slice(0, 2000), result.error, Date.now() - started]);
    }
    catch { /* logging must never break option resolution */ }
    if (!result.ok) {
        // Serve stale options rather than breaking the form — a dropdown that silently empties
        // out during an upstream blip is a worse failure than slightly outdated values.
        if (hit)
            return hit.options;
        throw err(502, 'OPTIONS_FETCH_FAILED', `Could not fetch options for ${def.label}: ${result.error}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(result.body);
    }
    catch {
        throw err(502, 'OPTIONS_PARSE_FAILED', `Options endpoint for ${def.label} did not return valid JSON`);
    }
    const arr = atPath(parsed, cfg.jsonPath);
    if (!Array.isArray(arr))
        throw err(502, 'OPTIONS_PARSE_FAILED', `Expected an array at ${cfg.jsonPath || 'the response root'} for ${def.label}`);
    const options = arr.map((item) => {
        if (item === null || item === undefined)
            return null;
        if (typeof item !== 'object')
            return { label: String(item), value: String(item) };
        const value = cfg.valueKey ? item[cfg.valueKey] : (item.value ?? item.id ?? item.code);
        const label = cfg.labelKey ? item[cfg.labelKey] : (item.label ?? item.name ?? item.title ?? value);
        if (value === undefined || value === null)
            return null;
        return { label: String(label ?? value), value: String(value) };
    }).filter(Boolean).slice(0, 1000);
    optionsCache.set(cacheKey, { options, at: Date.now(), ttl });
    return options;
}
/** GET the resolvable options for one field (static or API-backed). Used by the field renderer. */
customFieldsRouter.get('/:entity/:schemaName/options', async (req, res) => {
    try {
        const def = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT * FROM custom_field_defs WHERE entity=$1 AND schema_name=$2 AND is_active`, [req.params.entity, req.params.schemaName])).rows[0]);
        if (!def)
            throw err(404, 'NOT_FOUND', 'Field not found');
        if (def.options_source !== 'api') {
            const opts = (def.options || []).map((o) => (typeof o === 'object' ? o : { label: String(o), value: String(o) }));
            return res.json({ items: opts, source: 'static' });
        }
        await assertFeature(req.auth.tenantId, 'api_field_options');
        const items = await withTenant(req.auth.tenantId, c => resolveApiOptions(c, req.auth.tenantId, def, { force: req.query.refresh === 'true' }));
        res.json({ items, source: 'api' });
    }
    catch (e) {
        sendError(res, e);
    }
});
// entity: lead | opportunity | task  (activity types have their own sub-route)
customFieldsRouter.get('/:entity', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT * FROM custom_field_defs WHERE entity=$1 AND is_active ORDER BY sort_order`, [req.params.entity])).rows);
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
customFieldsRouter.post('/:entity', async (req, res) => {
    try {
        requireManage(req);
        const { label, type, options, mandatory = false, unique = false, section = 'Details', sortOrder = 100, optionsSource = 'static', optionsApi } = req.body || {};
        if (!label || !type)
            throw err(400, 'MISSING_FIELDS', 'label, type required');
        if (!['static', 'api'].includes(optionsSource))
            throw err(400, 'INVALID_VALUE', "optionsSource must be 'static' or 'api'");
        if (optionsSource === 'api') {
            if (!['dropdown', 'multiselect'].includes(type))
                throw err(400, 'INVALID_VALUE', 'API-sourced options only apply to dropdown/multiselect fields');
            if (!optionsApi?.url)
                throw err(400, 'MISSING_FIELDS', 'optionsApi.url is required when optionsSource is api');
            await assertFeature(req.auth.tenantId, 'api_field_options');
        }
        const schemaName = toSchemaName(label);
        const row = await withTenant(req.auth.tenantId, async (c) => {
            const r = await c.query(`INSERT INTO custom_field_defs (tenant_id, entity, schema_name, label, field_type, options, is_mandatory, is_unique, section, sort_order, options_source, options_api)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [req.auth.tenantId, req.params.entity, schemaName, label, type, options ? JSON.stringify(options) : null,
                mandatory, unique, section, sortOrder, optionsSource, optionsApi ? JSON.stringify(optionsApi) : null]);
            return r.rows[0];
        });
        res.status(201).json(row);
    }
    catch (e) {
        if (e?.code === '23505')
            return sendError(res, err(409, 'FIELD_EXISTS', 'A field with this name already exists'));
        sendError(res, e);
    }
});
// System fields (built-in columns like Email/Phone/Stage) can have their display label renamed
// or be hidden from views here too — just like custom fields — but never deleted (see DELETE below)
// and their type/options are meaningless for them, so those parts of the body are ignored.
customFieldsRouter.patch('/:entity/:schemaName', async (req, res) => {
    try {
        requireManage(req);
        const { label, options, mandatory, isActive, sortOrder } = req.body || {};
        const row = await withTenant(req.auth.tenantId, async (c) => {
            const r = await c.query(`UPDATE custom_field_defs SET label=COALESCE($3,label), options=COALESCE($4,options),
         is_mandatory=COALESCE($5,is_mandatory), is_active=COALESCE($6,is_active), sort_order=COALESCE($7,sort_order)
         WHERE entity=$1 AND schema_name=$2 RETURNING *`, [req.params.entity, req.params.schemaName, label, options ? JSON.stringify(options) : null, mandatory, isActive, sortOrder]);
            return r.rows[0];
        });
        if (!row)
            throw err(404, 'NOT_FOUND', 'Field not found');
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
customFieldsRouter.delete('/:entity/:schemaName', async (req, res) => {
    try {
        requireManage(req);
        await withTenant(req.auth.tenantId, async (c) => {
            const cur = (await c.query(`SELECT is_system, is_deletable FROM custom_field_defs WHERE entity=$1 AND schema_name=$2`, [req.params.entity, req.params.schemaName])).rows[0];
            if (!cur)
                throw err(404, 'NOT_FOUND', 'Field not found');
            if (cur.is_system || !cur.is_deletable)
                throw err(400, 'CANNOT_DELETE_SYSTEM_FIELD', 'Built-in fields can be renamed or hidden, but not deleted');
            await c.query(`DELETE FROM custom_field_defs WHERE entity=$1 AND schema_name=$2`, [req.params.entity, req.params.schemaName]);
        });
        res.status(204).send();
    }
    catch (e) {
        sendError(res, e);
    }
});
// stages & sources
export const stagesRouter = Router();
stagesRouter.get('/', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT * FROM lead_stages ORDER BY sort_order`)).rows);
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
stagesRouter.post('/', async (req, res) => {
    try {
        requireManage(req);
        const { name, isActiveStage = true, sortOrder = 100, isDefault = false } = req.body || {};
        if (!name)
            throw err(400, 'MISSING_FIELDS', 'name required');
        const row = await withTenant(req.auth.tenantId, async (c) => {
            if (isDefault)
                await c.query(`UPDATE lead_stages SET is_default=false`);
            const r = await c.query(`INSERT INTO lead_stages (tenant_id, name, is_active_stage, sort_order, is_default) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [req.auth.tenantId, name, isActiveStage, sortOrder, isDefault]);
            return r.rows[0];
        });
        res.status(201).json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
stagesRouter.patch('/:id', async (req, res) => {
    try {
        requireManage(req);
        const { name, sortOrder, isActiveStage } = req.body || {};
        const row = await withTenant(req.auth.tenantId, async (c) => {
            const r = await c.query(`UPDATE lead_stages SET name=COALESCE($2,name), sort_order=COALESCE($3,sort_order), is_active_stage=COALESCE($4,is_active_stage)
         WHERE id=$1 RETURNING *`, [req.params.id, name, sortOrder, isActiveStage]);
            return r.rows[0];
        });
        if (!row)
            throw err(404, 'NOT_FOUND', 'Stage not found');
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
export const sourcesRouter = Router();
sourcesRouter.get('/', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT * FROM lead_sources ORDER BY name`)).rows);
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
sourcesRouter.post('/', async (req, res) => {
    try {
        requireManage(req);
        const { name } = req.body || {};
        if (!name)
            throw err(400, 'MISSING_FIELDS', 'name required');
        const row = await withTenant(req.auth.tenantId, async (c) => (await c.query(`INSERT INTO lead_sources (tenant_id, name) VALUES ($1,$2) ON CONFLICT (tenant_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING *`, [req.auth.tenantId, name])).rows[0]);
        res.status(201).json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
