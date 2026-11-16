import { Router } from 'express';
import { control } from '../db.js';
import { err, sendError } from '../util.js';
/**
 * Named UI variants — host-admin managed, assigned per tenant.
 *
 * THE PROBLEM THIS SOLVES: with a single integer version you can only move forward. Real
 * rollouts aren't linear — you ship "2026 Refresh" to some customers, then a *different* group
 * asks for a change to the OLD interface. You need to branch from Classic, not from the newest.
 *
 * So variants are named, have lineage (parent_id), carry their own config flags, and each tenant
 * points at exactly one. Branching copies the parent's config into a new variant, which you then
 * evolve independently. Nothing about one variant's evolution can affect another's.
 *
 * Crucially this is still ONE codebase: the frontend reads `config` flags and renders
 * accordingly. It is not a per-tenant fork, which would destroy the ability to ship fixes.
 */
export const uiVariantsRouter = Router(); // host admin (control plane)
export const uiVariantPublicRouter = Router(); // tenant-facing read-only
function requireRole(req, roles) {
    if (!roles.includes(req.hostUser?.role))
        throw err(403, 'FORBIDDEN', `Requires role: ${roles.join('/')}`);
}
const STATUSES = ['draft', 'testing', 'released', 'deprecated'];
uiVariantsRouter.get('/', async (_req, res) => {
    try {
        const rows = (await control(c => c.query(`SELECT v.*, p.key AS parent_key, p.name AS parent_name,
              (SELECT COUNT(*) FROM tenants t WHERE t.ui_variant_id = v.id)::int AS tenant_count
       FROM ui_variants v LEFT JOIN ui_variants p ON p.id = v.parent_id
       ORDER BY v.created_at`))).rows;
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
/** Create a variant, optionally branched from an existing one (config is copied). */
uiVariantsRouter.post('/', async (req, res) => {
    try {
        requireRole(req, ['owner', 'admin']);
        const { key, name, description, parentKey, config, status = 'draft' } = req.body || {};
        if (!key || !name)
            throw err(400, 'MISSING_FIELDS', 'key and name required');
        if (!/^[a-z0-9_-]{2,40}$/.test(key))
            throw err(400, 'INVALID_VALUE', 'key must be 2-40 chars, lowercase letters/numbers/_/- only');
        if (!STATUSES.includes(status))
            throw err(400, 'INVALID_VALUE', `status must be one of ${STATUSES.join('|')}`);
        const row = await control(async (c) => {
            let parentId = null;
            let baseConfig = {};
            if (parentKey) {
                const p = (await c.query(`SELECT id, config FROM ui_variants WHERE key=$1`, [parentKey])).rows[0];
                if (!p)
                    throw err(404, 'NOT_FOUND', `Parent variant '${parentKey}' not found`);
                parentId = p.id;
                baseConfig = p.config || {}; // branch = start from the parent's exact config
            }
            const merged = { ...baseConfig, ...(config || {}) };
            return (await c.query(`INSERT INTO ui_variants (key, name, description, parent_id, config, status)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [key, name, description || null, parentId, JSON.stringify(merged), status])).rows[0];
        });
        res.status(201).json(row);
    }
    catch (e) {
        if (e?.code === '23505')
            return sendError(res, err(409, 'VARIANT_EXISTS', 'A variant with this key already exists'));
        sendError(res, e);
    }
});
/** Rename / retag / edit config. Renaming is safe — tenants point at the id, not the name. */
uiVariantsRouter.patch('/:key', async (req, res) => {
    try {
        requireRole(req, ['owner', 'admin']);
        const { name, description, config, status } = req.body || {};
        if (status && !STATUSES.includes(status))
            throw err(400, 'INVALID_VALUE', `status must be one of ${STATUSES.join('|')}`);
        const row = (await control(c => c.query(`UPDATE ui_variants SET name=COALESCE($2,name), description=COALESCE($3,description),
         config=COALESCE($4,config), status=COALESCE($5,status), updated_at=now()
       WHERE key=$1 RETURNING *`, [req.params.key, name, description, config ? JSON.stringify(config) : null, status]))).rows[0];
        if (!row)
            throw err(404, 'NOT_FOUND', 'Variant not found');
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
uiVariantsRouter.delete('/:key', async (req, res) => {
    try {
        requireRole(req, ['owner']);
        await control(async (c) => {
            const v = (await c.query(`SELECT id, is_default FROM ui_variants WHERE key=$1`, [req.params.key])).rows[0];
            if (!v)
                throw err(404, 'NOT_FOUND', 'Variant not found');
            if (v.is_default)
                throw err(400, 'CANNOT_DELETE_DEFAULT', 'The default variant cannot be deleted');
            const inUse = (await c.query(`SELECT COUNT(*)::int AS n FROM tenants WHERE ui_variant_id=$1`, [v.id])).rows[0].n;
            if (inUse > 0)
                throw err(400, 'VARIANT_IN_USE', `${inUse} tenant(s) still use this variant — move them first`);
            const children = (await c.query(`SELECT COUNT(*)::int AS n FROM ui_variants WHERE parent_id=$1`, [v.id])).rows[0].n;
            if (children > 0)
                throw err(400, 'VARIANT_HAS_CHILDREN', `${children} variant(s) were branched from this one`);
            await c.query(`DELETE FROM ui_variants WHERE id=$1`, [v.id]);
        });
        res.status(204).send();
    }
    catch (e) {
        sendError(res, e);
    }
});
/** Assign a variant to a tenant — the per-customer switch. */
uiVariantsRouter.put('/assign/:tenantId', async (req, res) => {
    try {
        requireRole(req, ['owner', 'admin']);
        const { variantKey } = req.body || {};
        if (!variantKey)
            throw err(400, 'MISSING_FIELDS', 'variantKey required');
        const row = await control(async (c) => {
            const v = (await c.query(`SELECT id, key, name FROM ui_variants WHERE key=$1`, [variantKey])).rows[0];
            if (!v)
                throw err(404, 'NOT_FOUND', `Variant '${variantKey}' not found`);
            const t = (await c.query(`UPDATE tenants SET ui_variant_id=$2, updated_at=now() WHERE id=$1 RETURNING id, code, ui_variant_id`, [req.params.tenantId, v.id])).rows[0];
            if (!t)
                throw err(404, 'NOT_FOUND', 'Tenant not found');
            return { tenant: t, variant: v };
        });
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
/** Which tenants are on which variant — the rollout view. */
uiVariantsRouter.get('/rollout', async (_req, res) => {
    try {
        const rows = (await control(c => c.query(`SELECT v.key, v.name, v.status,
              COALESCE(json_agg(json_build_object('id', t.id, 'code', t.code, 'name', t.name)
                       ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL), '[]') AS tenants
       FROM ui_variants v LEFT JOIN tenants t ON t.ui_variant_id = v.id
       GROUP BY v.id ORDER BY v.created_at`))).rows;
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---------------------------------------------------------------------------
// Tenant-facing: which variant am I on, and what does it enable?
// ---------------------------------------------------------------------------
uiVariantPublicRouter.get('/', async (req, res) => {
    try {
        const row = (await control(c => c.query(`SELECT v.key, v.name, v.config FROM tenants t
       JOIN ui_variants v ON v.id = t.ui_variant_id WHERE t.id=$1`, [req.auth.tenantId]))).rows[0];
        // Fall back to the default variant rather than erroring — a missing assignment must never
        // break the app shell.
        if (!row) {
            const def = (await control(c => c.query(`SELECT key, name, config FROM ui_variants WHERE is_default LIMIT 1`))).rows[0];
            return res.json(def || { key: 'classic', name: 'Classic', config: {} });
        }
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
