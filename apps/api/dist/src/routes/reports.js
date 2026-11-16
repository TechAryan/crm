import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { resolveVisibleOwnerIds } from '../permissions.js';
export const reportsRouter = Router();
/**
 * Dashboard overview: funnel, sources, trend, pipeline, tasks, and the
 * "Needs Attention" engine (active leads untouched for N+ days, overdue tasks).
 * Scoped by the caller's record scope: 'all' sees everything, 'own' sees just their book,
 * 'team' sees their own plus their hierarchy subtree (their reports, reports' reports, ...).
 * Pass ?asUserId= to have a manager view a specific direct/indirect report's numbers instead
 * of their whole subtree (used by the Dashboard's "View as" picker) — only ever narrows, never widens.
 */
reportsRouter.get('/overview', async (req, res) => {
    try {
        const scope = req.auth.perms.lead.view;
        const coldDays = Math.min(60, Math.max(2, parseInt(String(req.query.coldDays || '7'))));
        const asUserId = req.query.asUserId;
        const data = await withTenant(req.auth.tenantId, async (c) => {
            let visibleIds = await resolveVisibleOwnerIds(c, req.auth.tenantId, req.auth.userId, scope);
            if (asUserId) {
                // Managers can drill into one person's subtree numbers; never widens their own access.
                if (visibleIds !== null && !visibleIds.includes(asUserId))
                    throw err(403, 'FORBIDDEN', 'Not in your hierarchy');
                visibleIds = [asUserId];
            }
            const own = visibleIds !== null;
            const p = own ? [visibleIds] : [];
            const ownerCond = own ? `AND l.owner_id = ANY($1)` : '';
            const ownerCondT = own ? `AND t.owner_id = ANY($1)` : '';
            const ownerCondO = own ? `AND o.owner_id = ANY($1)` : '';
            const byStage = (await c.query(`SELECT s.name, s.is_active_stage, s.sort_order, COUNT(l.id)::int AS count
         FROM lead_stages s LEFT JOIN leads l ON l.stage_id = s.id AND l.deleted_at IS NULL ${ownerCond}
         GROUP BY s.id ORDER BY s.sort_order`, p)).rows;
            const bySource = (await c.query(`SELECT COALESCE(src.name, 'Unknown') AS name, COUNT(l.id)::int AS count
         FROM leads l LEFT JOIN lead_sources src ON src.id = l.source_id
         WHERE l.deleted_at IS NULL ${ownerCond}
         GROUP BY src.name ORDER BY count DESC LIMIT 8`, p)).rows;
            // PERFORMANCE: the obvious form of this query joins the day series to leads on
            // `l.created_at::date = d.day`, but casting the column defeats the index on created_at,
            // so Postgres scans every lead 14 times. Measured at 217ms p95 with 100k leads.
            //
            // Instead: aggregate ONCE over a 14-day range (an index range scan), then left-join the
            // day series onto that small result to fill in zero-days. Same output, ~10x faster, and
            // it stays fast as the table grows because the scan is bounded by date, not table size.
            const trend = (await c.query(`WITH counts AS (
           SELECT date_trunc('day', l.created_at)::date AS day, COUNT(*)::int AS count
           FROM leads l
           WHERE l.deleted_at IS NULL
             AND l.created_at >= CURRENT_DATE - INTERVAL '13 days'
             ${ownerCond}
           GROUP BY 1
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.count, 0)::int AS count
         FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, '1 day') d(day)
         LEFT JOIN counts c ON c.day = d.day::date
         ORDER BY d.day`, p)).rows;
            const pipeline = (await c.query(`SELECT o.status, COUNT(*)::int AS count, COALESCE(SUM(o.amount),0)::numeric AS amount
         FROM opportunities o WHERE o.deleted_at IS NULL ${ownerCondO} GROUP BY o.status`, p)).rows;
            const taskStats = (await c.query(`SELECT COUNT(*) FILTER (WHERE t.status='open')::int AS open,
                COUNT(*) FILTER (WHERE t.status='open' AND t.due_at < now())::int AS overdue
         FROM tasks t WHERE TRUE ${ownerCondT}`, p)).rows[0];
            // Needs Attention: leads in an active stage with no activity in coldDays+ days.
            //
            // PERFORMANCE: the LATERAL MAX(activity_time) has to run for every candidate lead, and the
            // GREATEST(...) in the WHERE clause is unindexable, so the original form evaluated it
            // across the whole table (159ms p95 at 100k leads). Two changes:
            //   1. Pre-filter on `l.updated_at` FIRST — that IS indexable, and a lead touched recently
            //      cannot possibly be cold, so it eliminates most rows before the expensive part.
            //   2. Only then run the LATERAL on the surviving candidates, capped.
            const coldParams = [...p, coldDays];
            const dayParam = `$${coldParams.length}`;
            const cold = (await c.query(`WITH candidates AS (
           SELECT l.id, l.first_name, l.last_name, l.email, l.phone, l.score, l.stage_id,
                  l.updated_at, l.created_at
           FROM leads l
           JOIN lead_stages s ON s.id = l.stage_id AND s.is_active_stage
           WHERE l.deleted_at IS NULL ${ownerCond}
             -- indexable pre-filter: recently-updated leads are never cold
             AND l.updated_at < now() - (${dayParam} || ' days')::interval
           ORDER BY l.updated_at ASC
           LIMIT 500
         )
         SELECT cd.id, cd.first_name, cd.last_name, cd.email, cd.phone, cd.score,
                s.name AS stage,
                GREATEST(cd.updated_at, COALESCE(la.last_activity, cd.created_at)) AS last_touch
         FROM candidates cd
         JOIN lead_stages s ON s.id = cd.stage_id
         LEFT JOIN LATERAL (
           SELECT MAX(a.activity_time) AS last_activity FROM activities a WHERE a.lead_id = cd.id
         ) la ON TRUE
         WHERE GREATEST(cd.updated_at, COALESCE(la.last_activity, cd.created_at))
               < now() - (${dayParam} || ' days')::interval
         ORDER BY last_touch ASC LIMIT 10`, coldParams)).rows;
            const overdueTasks = (await c.query(`SELECT t.id, t.name, t.due_at, l.first_name, l.last_name, l.id AS lead_id
         FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id
         WHERE t.status='open' AND t.due_at < now() ${ownerCondT}
         ORDER BY t.due_at ASC LIMIT 10`, p)).rows;
            const totals = (await c.query(`SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE l.created_at > now() - INTERVAL '7 days')::int AS last7
         FROM leads l WHERE l.deleted_at IS NULL ${ownerCond}`, p)).rows[0];
            // Direct reports, for the Dashboard's "View as" manager picker.
            const directReports = (await c.query(`SELECT id, first_name, last_name FROM users WHERE manager_id=$1 AND is_active ORDER BY first_name`, [req.auth.userId])).rows;
            return { byStage, bySource, trend, pipeline, taskStats, cold, overdueTasks, totals, coldDays, directReports, viewingAsUserId: asUserId || null };
        });
        res.json(data);
    }
    catch (e) {
        sendError(res, e);
    }
});
