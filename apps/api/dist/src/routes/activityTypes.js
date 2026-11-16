import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError, toSchemaName } from '../util.js';
export const activityTypesRouter = Router();
function requireSettings(req, key) {
    if (!req.auth.perms.settings?.[key])
        throw err(403, 'FORBIDDEN', `Missing settings permission: ${key}`);
}
activityTypesRouter.get('/', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => {
            const r = await c.query(`SELECT * FROM activity_types WHERE is_active ORDER BY name`);
            return r.rows;
        });
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
// create custom activity type + its field schema
activityTypesRouter.post('/', async (req, res) => {
    try {
        requireSettings(req, 'manageFields');
        const { name, direction = 0, score = 0, allowAttachments = true, fields = [] } = req.body || {};
        if (!name)
            throw err(400, 'MISSING_FIELDS', 'name required');
        const result = await withTenant(req.auth.tenantId, async (c) => {
            const t = await c.query(`INSERT INTO activity_types (tenant_id, name, direction, score, allow_attachments)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`, [req.auth.tenantId, name, direction, score, allowAttachments]);
            const type = t.rows[0];
            for (const f of fields) {
                const schemaName = toSchemaName(f.label);
                await c.query(`INSERT INTO custom_field_defs (tenant_id, entity, schema_name, label, field_type, options, is_mandatory, section, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [req.auth.tenantId, `activity_type:${type.id}`, schemaName, f.label, f.type, JSON.stringify(f.options || null), !!f.mandatory, f.section || 'Details', f.sortOrder || 100]);
            }
            return type;
        });
        res.status(201).json(result);
    }
    catch (e) {
        sendError(res, e);
    }
});
activityTypesRouter.get('/:id/fields', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => {
            const r = await c.query(`SELECT * FROM custom_field_defs WHERE entity=$1 AND is_active ORDER BY sort_order`, [`activity_type:${req.params.id}`]);
            return r.rows;
        });
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
activityTypesRouter.patch('/:id', async (req, res) => {
    try {
        requireSettings(req, 'manageFields');
        const { name, score, isActive, allowAttachments } = req.body || {};
        const row = await withTenant(req.auth.tenantId, async (c) => {
            const r = await c.query(`UPDATE activity_types SET name=COALESCE($2,name), score=COALESCE($3,score),
         is_active=COALESCE($4,is_active), allow_attachments=COALESCE($5,allow_attachments) WHERE id=$1 RETURNING *`, [req.params.id, name, score, isActive, allowAttachments]);
            return r.rows[0];
        });
        if (!row)
            throw err(404, 'NOT_FOUND', 'Activity type not found');
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
