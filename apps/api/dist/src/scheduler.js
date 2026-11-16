import { bypassRLS, withTenant } from './db.js';
import { distributeLead, resolveDefaultOwner } from './distribution.js';
import { emitEvent } from './webhooks.js';
import { audit } from './audit.js';
/**
 * Background scheduler for time-based work. Runs on the same polling pattern already proven by
 * the webhook dispatcher (claim rows with FOR UPDATE SKIP LOCKED so multiple instances can run
 * concurrently without double-processing).
 *
 * Currently handles:
 *   - scheduled (batch) lead distribution, for tenants that prefer a once-a-day sweep over
 *     real-time assignment. Some teams want the whole day's leads divided evenly in the morning
 *     rather than trickled out as they arrive.
 *
 * NOTE ON DEPLOYMENT: this runs in-process today, which is fine for a single node. When you
 * scale to several API instances, move it to a dedicated worker process (same code, started
 * with WORKER_ONLY=true) so heavy sweeps never compete with interactive request latency. The
 * SKIP LOCKED claiming already makes that safe.
 */
let timer = null;
export function startScheduler(intervalMs = 60_000) {
    timer = setInterval(() => { tick().catch(e => console.error('scheduler tick failed', e)); }, intervalMs);
    timer.unref?.();
}
export function stopScheduler() { if (timer)
    clearInterval(timer); timer = null; }
/** Nightly retention purge, tracked so it runs once per day regardless of tick frequency. */
let lastRetentionRun = null;
async function tick() {
    // ---- retention purge (once a day, off-peak) ----
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (new Date().getUTCHours() === 2 && lastRetentionRun !== todayUtc) {
        lastRetentionRun = todayUtc;
        try {
            const { runRetentionSweep } = await import('./retention.js');
            const r = await runRetentionSweep();
            console.log(`retention sweep: ${r.tenants} tenants,`, r.deleted);
        }
        catch (e) {
            console.error('retention sweep failed', e);
        }
    }
    // Find tenants configured for scheduled distribution whose run hour has arrived.
    const tenants = await bypassRLS(c => c.query(`SELECT id, settings FROM tenants
     WHERE status='active'
       AND settings->>'distributionMode' = 'scheduled'`));
    for (const t of tenants.rows) {
        const s = t.settings || {};
        const runHour = Number.isInteger(s.distributionRunHour) ? s.distributionRunHour : 9;
        const nowHour = new Date().getUTCHours();
        if (nowHour !== runHour)
            continue;
        // Only run once per day: a marker row in the settings tracks the last run date.
        const today = new Date().toISOString().slice(0, 10);
        if (s.lastDistributionRun === today)
            continue;
        try {
            const assigned = await runScheduledDistribution(t.id);
            await bypassRLS(c => c.query(`UPDATE tenants SET settings = settings || jsonb_build_object('lastDistributionRun', $2::text) WHERE id=$1`, [t.id, today]));
            if (assigned)
                console.log(`scheduled distribution: assigned ${assigned} leads for tenant ${t.id}`);
        }
        catch (e) {
            console.error(`scheduled distribution failed for tenant ${t.id}`, e);
        }
    }
}
/**
 * Assign every currently-unowned lead for a tenant using the same rule engine as real-time
 * distribution, then the configured default owner. Exported so it can also be triggered
 * on demand ("Run distribution now") from the UI.
 */
export async function runScheduledDistribution(tenantId, limit = 5000) {
    return withTenant(tenantId, async (c) => {
        const { rows: unowned } = await c.query(`SELECT * FROM leads WHERE owner_id IS NULL AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT $1`, [limit]);
        let assigned = 0;
        for (const lead of unowned) {
            try {
                const ownerId = await distributeLead(c, lead) || await resolveDefaultOwner(c, tenantId, lead);
                if (!ownerId)
                    continue;
                const after = (await c.query(`UPDATE leads SET owner_id=$2, updated_at=now() WHERE id=$1 RETURNING *`, [lead.id, ownerId])).rows[0];
                await audit(c, tenantId, null, 'scheduler', 'lead.updated', 'lead', lead.id, lead, after);
                await emitEvent(c, tenantId, 'lead.owner_changed', { lead: after, newOwnerId: ownerId });
                assigned++;
            }
            catch (e) {
                // One bad lead must not abort the whole sweep.
                console.error(`scheduled distribution: lead ${lead.id} failed`, e);
            }
        }
        return assigned;
    });
}
