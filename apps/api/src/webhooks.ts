import type pg from 'pg';
import { pool, withTenant, bypassRLS } from './db.js';
import { hmacSign } from './util.js';

/**
 * Queue an event for all matching webhook subscriptions.
 * Must be called inside a withTenant transaction (client has RLS context).
 */
export async function emitEvent(
  client: pg.PoolClient,
  tenantId: string,
  event: string,
  payload: any,
  changedFields: string[] = []
) {
  const subs = await client.query(
    `SELECT id, filters FROM webhook_subscriptions WHERE is_active AND $1 = ANY(events)`,
    [event]
  );
  for (const sub of subs.rows) {
    const f = sub.filters || {};
    if (f.changedField && changedFields.length && !changedFields.includes(f.changedField)) continue;
    await client.query(
      `INSERT INTO webhook_deliveries (tenant_id, subscription_id, event, payload)
       VALUES ($1,$2,$3,$4)`,
      [tenantId, sub.id, event, JSON.stringify({ event, tenantId, occurredAt: new Date().toISOString(), data: payload })]
    );
  }
}

const BACKOFF_MINUTES = [1, 5, 15, 60, 240]; // 5 attempts, exponential-ish
let timer: NodeJS.Timeout | null = null;

/** Background dispatcher: polls pending deliveries and POSTs with HMAC signature. */
export function startWebhookDispatcher(intervalMs = 5000) {
  timer = setInterval(async () => {
    try {
      // webhook_deliveries is tenant-RLS-protected; this system-level scan needs cross-tenant
      // visibility just to find due rows, so it bypasses RLS. Actual delivery still runs through
      // withTenant/deliverOne below, so RLS is enforced for everything else about the row.
      const due = await bypassRLS(c => c.query(
        `SELECT wd.id, wd.tenant_id FROM webhook_deliveries wd
         WHERE wd.status='pending' AND wd.next_attempt_at <= now()
         ORDER BY wd.id LIMIT 20`
      ));
      for (const row of due.rows) {
        await deliverOne(row.tenant_id, row.id).catch(e => console.error('webhook delivery error', e));
      }
    } catch (e) { console.error('webhook dispatcher tick failed', e); }
  }, intervalMs);
  timer.unref?.();
}
export function stopWebhookDispatcher() { if (timer) clearInterval(timer); }

async function deliverOne(tenantId: string, deliveryId: number) {
  await withTenant(tenantId, async c => {
    const d = await c.query(
      `SELECT wd.*, ws.url, ws.secret, ws.custom_headers FROM webhook_deliveries wd
       JOIN webhook_subscriptions ws ON ws.id = wd.subscription_id
       WHERE wd.id=$1 AND wd.status='pending' FOR UPDATE SKIP LOCKED`, [deliveryId]);
    const del = d.rows[0];
    if (!del) return;
    const body = JSON.stringify(del.payload);
    const signature = hmacSign(del.secret, body);
    let ok = false, code: number | null = null, error: string | null = null;
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(del.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nexcrm-event': del.event,
          'x-nexcrm-signature': `sha256=${signature}`,
          ...(del.custom_headers || {}),
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(to);
      code = resp.status;
      ok = resp.ok;
      if (!ok) error = `HTTP ${resp.status}`;
    } catch (e: any) {
      error = e?.message || 'fetch failed';
    }
    const attempts = del.attempts + 1;
    if (ok) {
      await c.query(`UPDATE webhook_deliveries SET status='success', attempts=$2, last_response_code=$3 WHERE id=$1`,
        [deliveryId, attempts, code]);
    } else if (attempts >= BACKOFF_MINUTES.length) {
      await c.query(`UPDATE webhook_deliveries SET status='failed', attempts=$2, last_response_code=$3, last_error=$4 WHERE id=$1`,
        [deliveryId, attempts, code, error]);
    } else {
      await c.query(
        `UPDATE webhook_deliveries SET attempts=$2, last_response_code=$3, last_error=$4,
         next_attempt_at = now() + ($5 || ' minutes')::interval WHERE id=$1`,
        [deliveryId, attempts, code, error, String(BACKOFF_MINUTES[attempts])]);
    }
  });
}
