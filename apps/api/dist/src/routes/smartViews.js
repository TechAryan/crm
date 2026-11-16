import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
export const smartViewsRouter = Router();
const ENTITIES = new Set(['lead', 'opportunity']);
// List views visible to the caller for an entity: shared views + the caller's own.
smartViewsRouter.get('/', async (req, res) => {
    try {
        const entity = String(req.query.entity || 'lead');
        if (!ENTITIES.has(entity))
            throw err(400, 'INVALID_ENTITY', `Unknown entity: ${entity}`);
        const rows = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT * FROM smart_views WHERE entity=$1 AND (is_shared = true OR owner_id = $2) ORDER BY name`, [entity, req.auth.userId])).rows);
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
smartViewsRouter.post('/', async (req, res) => {
    try {
        const { entity = 'lead', name, filters = [], columns = [], isShared = false } = req.body || {};
        if (!ENTITIES.has(entity))
            throw err(400, 'INVALID_ENTITY', `Unknown entity: ${entity}`);
        if (!name)
            throw err(400, 'MISSING_FIELDS', 'name required');
        if (!Array.isArray(filters) || !Array.isArray(columns))
            throw err(400, 'INVALID_BODY', 'filters and columns must be arrays');
        // Only admins (manageFields) may create tenant-wide shared views.
        const shared = !!isShared && !!req.auth.perms.settings?.manageFields;
        const row = await withTenant(req.auth.tenantId, async (c) => (await c.query(`INSERT INTO smart_views (tenant_id, entity, name, filters, columns, is_shared, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.auth.tenantId, entity, name, JSON.stringify(filters), JSON.stringify(columns), shared, req.auth.userId])).rows[0]);
        res.status(201).json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
smartViewsRouter.patch('/:id', async (req, res) => {
    try {
        const { name, filters, columns, isShared } = req.body || {};
        const row = await withTenant(req.auth.tenantId, async (c) => {
            const cur = (await c.query(`SELECT * FROM smart_views WHERE id=$1`, [req.params.id])).rows[0];
            if (!cur)
                throw err(404, 'NOT_FOUND', 'View not found');
            // Only the owner or an admin can edit.
            const isAdmin = !!req.auth.perms.settings?.manageFields;
            if (cur.owner_id !== req.auth.userId && !isAdmin)
                throw err(403, 'FORBIDDEN', 'Not your view');
            const shared = isShared === undefined ? cur.is_shared : (!!isShared && isAdmin);
            return (await c.query(`UPDATE smart_views SET name=COALESCE($2,name), filters=COALESCE($3,filters),
           columns=COALESCE($4,columns), is_shared=$5 WHERE id=$1 RETURNING *`, [req.params.id, name, filters ? JSON.stringify(filters) : null,
                columns ? JSON.stringify(columns) : null, shared])).rows[0];
        });
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
smartViewsRouter.delete('/:id', async (req, res) => {
    try {
        await withTenant(req.auth.tenantId, async (c) => {
            const cur = (await c.query(`SELECT * FROM smart_views WHERE id=$1`, [req.params.id])).rows[0];
            if (!cur)
                throw err(404, 'NOT_FOUND', 'View not found');
            const isAdmin = !!req.auth.perms.settings?.manageFields;
            if (cur.owner_id !== req.auth.userId && !isAdmin)
                throw err(403, 'FORBIDDEN', 'Not your view');
            await c.query(`DELETE FROM smart_views WHERE id=$1`, [req.params.id]);
        });
        res.status(204).send();
    }
    catch (e) {
        sendError(res, e);
    }
});
