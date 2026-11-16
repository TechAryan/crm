import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { audit } from '../audit.js';
/**
 * Full tenant data export.
 *
 * WHY IT MATTERS: on churn you are contractually and (under DPDP/GDPR) legally obliged to hand
 * the customer's data back. Doing it ad-hoc with SQL under time pressure is how mistakes happen.
 * It's also a sales asset — "your data is yours, one click" removes a real objection about
 * lock-in.
 *
 * DESIGN: streams NDJSON (one JSON object per line) rather than building a giant array in memory,
 * so a tenant with millions of rows exports without the API running out of memory. Each section
 * is a separate line-delimited block with a header, so the file is both greppable and parseable.
 */
export const dataExportRouter = Router();
/** Tables exported, in dependency order so an import could replay them. */
const EXPORT_SECTIONS = [
    { name: 'users', sql: `SELECT id, email, first_name, last_name, phone, role_id, team_id, manager_id, is_active, fields, created_at FROM users` },
    { name: 'roles', sql: `SELECT * FROM roles` },
    { name: 'permission_sets', sql: `SELECT * FROM permission_sets` },
    { name: 'teams', sql: `SELECT * FROM teams` },
    { name: 'custom_field_defs', sql: `SELECT * FROM custom_field_defs` },
    { name: 'lead_stages', sql: `SELECT * FROM lead_stages` },
    { name: 'lead_sources', sql: `SELECT * FROM lead_sources` },
    { name: 'activity_types', sql: `SELECT * FROM activity_types` },
    { name: 'opportunity_types', sql: `SELECT * FROM opportunity_types` },
    { name: 'leads', sql: `SELECT * FROM leads WHERE deleted_at IS NULL` },
    { name: 'opportunities', sql: `SELECT * FROM opportunities WHERE deleted_at IS NULL` },
    { name: 'activities', sql: `SELECT * FROM activities` },
    { name: 'tasks', sql: `SELECT * FROM tasks` },
    { name: 'notes', sql: `SELECT * FROM notes` },
    { name: 'distribution_rules', sql: `SELECT * FROM distribution_rules` },
    { name: 'automation_rules', sql: `SELECT * FROM automation_rules` },
    { name: 'custom_actions', sql: `SELECT * FROM custom_actions` },
    { name: 'forms', sql: `SELECT * FROM forms` },
    { name: 'smart_views', sql: `SELECT * FROM smart_views` },
    { name: 'message_templates', sql: `SELECT * FROM message_templates` },
    { name: 'embedded_widgets', sql: `SELECT * FROM embedded_widgets` },
    { name: 'payment_links', sql: `SELECT id, lead_id, opportunity_id, amount, currency, description, status, paid_at, paid_amount, reference, created_at FROM payment_links` },
    { name: 'audit_log', sql: `SELECT * FROM audit_log` },
    // NOTE: connectors are deliberately excluded — they hold encrypted third-party credentials
    // that must never leave our system, even to their owner (they have them already).
];
const CHUNK = 2000;
/**
 * GET /v1/export/full — streams the whole tenant as NDJSON.
 * Requires export permission on leads (the broadest data) plus settings admin, because this is
 * effectively "give me everything".
 */
dataExportRouter.get('/full', async (req, res) => {
    try {
        if (!req.auth.perms.settings?.manageRoles)
            throw err(403, 'FORBIDDEN', 'Only a settings administrator can export all data');
        if (!req.auth.perms.lead?.export)
            throw err(403, 'FORBIDDEN', 'Your permission set does not allow exporting data');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="nexcrm-export-${req.auth.tenantCode}-${stamp}.ndjson"`);
        const write = (obj) => res.write(`${JSON.stringify(obj)}\n`);
        write({ _meta: 'nexcrm-export', version: 1, tenantCode: req.auth.tenantCode, exportedAt: new Date().toISOString() });
        const counts = {};
        await withTenant(req.auth.tenantId, async (c) => {
            for (const section of EXPORT_SECTIONS) {
                write({ _section: section.name });
                let offset = 0, n = 0;
                // Keyset-free pagination is fine here: we hold one transaction, so the snapshot is stable.
                for (;;) {
                    const rows = (await c.query(`${section.sql} LIMIT ${CHUNK} OFFSET ${offset}`)).rows;
                    if (!rows.length)
                        break;
                    for (const r of rows)
                        write({ _t: section.name, ...r });
                    n += rows.length;
                    offset += CHUNK;
                    if (rows.length < CHUNK)
                        break;
                }
                counts[section.name] = n;
            }
            await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'data.exported', 'tenant', req.auth.tenantId, null, { counts });
        });
        write({ _meta: 'end', counts });
        res.end();
    }
    catch (e) {
        // If we've already started streaming we can't send a JSON error — close with a marker line
        // so the consumer can tell the file is incomplete rather than silently truncated.
        if (res.headersSent) {
            try {
                res.write(`${JSON.stringify({ _meta: 'error', error: e?.message || 'export failed' })}\n`);
            }
            catch { /* closed */ }
            try {
                res.end();
            }
            catch { /* closed */ }
        }
        else
            sendError(res, e);
    }
});
/** Row counts without exporting — lets a customer see the scope before downloading. */
dataExportRouter.get('/summary', async (req, res) => {
    try {
        if (!req.auth.perms.settings?.manageRoles)
            throw err(403, 'FORBIDDEN', 'Only a settings administrator can view the export summary');
        const counts = await withTenant(req.auth.tenantId, async (c) => {
            const out = {};
            for (const s of EXPORT_SECTIONS) {
                const sql = s.sql.replace(/^SELECT [\s\S]*? FROM /i, 'SELECT COUNT(*)::int AS n FROM ');
                out[s.name] = Number((await c.query(sql)).rows[0]?.n || 0);
            }
            return out;
        });
        res.json({ sections: counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
    }
    catch (e) {
        sendError(res, e);
    }
});
