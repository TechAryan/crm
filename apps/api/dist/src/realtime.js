import pg from 'pg';
import { config } from './config.js';
import { control, withTenant } from './db.js';
/**
 * Realtime push to a specific logged-in user — the transport behind telephony screen-pop.
 *
 * WHY SSE, NOT WEBSOCKETS: this traffic is one-directional (server -> browser). SSE runs over
 * ordinary HTTP, reconnects automatically in the browser with no client library, and needs no
 * extra dependency or protocol upgrade at the load balancer. WebSockets would add bidirectional
 * machinery we don't need.
 *
 * WHY POSTGRES LISTEN/NOTIFY: the telephony webhook can land on API instance A while the
 * agent's browser is connected to instance B. A purely in-memory subscriber registry would
 * silently drop the event in that case — and it would work perfectly in dev (one process) then
 * break the moment you scale out, which is the worst kind of bug. NOTIFY fans the event out to
 * every instance; whichever one holds that user's connection delivers it. We already depend on
 * Postgres, so this adds no new infrastructure (no Redis).
 *
 * NOTE ON NOTIFY LIMITS: payloads are capped at ~8000 bytes, so we publish a small envelope
 * (tenant, user, event id) and the client reads the full row. That also means an event is never
 * lost if no instance holds the connection — it stays in realtime_events for later delivery.
 */
const CHANNEL = 'nexcrm_realtime';
const subscribers = new Set();
let listener = null;
let reconnectTimer = null;
/** Start the dedicated LISTEN connection. A pool client can't be used: LISTEN is per-session. */
export async function startRealtime() {
    if (listener)
        return;
    try {
        listener = new pg.Client({ connectionString: config.databaseUrl });
        listener.on('error', e => { console.error('realtime listener error', e); scheduleReconnect(); });
        listener.on('end', () => scheduleReconnect());
        await listener.connect();
        await listener.query(`LISTEN ${CHANNEL}`);
        listener.on('notification', msg => {
            if (msg.channel !== CHANNEL || !msg.payload)
                return;
            try {
                deliverLocal(JSON.parse(msg.payload));
            }
            catch (e) {
                console.error('realtime notification parse failed', e);
            }
        });
        console.log('realtime listener connected');
    }
    catch (e) {
        console.error('realtime listener failed to start', e);
        scheduleReconnect();
    }
}
function scheduleReconnect() {
    if (reconnectTimer)
        return;
    const old = listener;
    listener = null;
    try {
        old?.end?.().catch(() => { });
    }
    catch { /* already closed */ }
    reconnectTimer = setTimeout(() => { reconnectTimer = null; startRealtime(); }, 5000);
    reconnectTimer.unref?.();
}
export async function stopRealtime() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    for (const s of subscribers) {
        clearInterval(s.heartbeat);
        try {
            s.res.end();
        }
        catch { /* closed */ }
    }
    subscribers.clear();
    const l = listener;
    listener = null;
    if (l)
        await l.end().catch(() => { });
}
/** Deliver to any locally-held connections for this user. */
function deliverLocal(env) {
    for (const s of subscribers) {
        if (s.tenantId !== env.tenantId || s.userId !== env.userId)
            continue;
        try {
            s.res.write(`event: ${env.kind}\n`);
            s.res.write(`data: ${JSON.stringify(env.data)}\n\n`);
        }
        catch (e) {
            console.error('SSE write failed', e);
        }
    }
}
/**
 * Register an SSE connection for a user.
 * Scoping is taken from the authenticated session only — never from query params — so one
 * tenant can never subscribe to another tenant's (or another user's) events.
 */
export function addSubscriber(tenantId, userId, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // stop nginx buffering the stream
    res.flushHeaders?.();
    res.write(': connected\n\n');
    // Keep-alive comment every 25s: proxies and load balancers commonly kill idle connections
    // at 30-60s, and a dead stream that looks alive is worse than a reconnect.
    const heartbeat = setInterval(() => {
        try {
            res.write(': ping\n\n');
        }
        catch { /* client gone */ }
    }, 25_000);
    heartbeat.unref?.();
    const sub = { tenantId, userId, res, heartbeat };
    subscribers.add(sub);
    return () => { clearInterval(heartbeat); subscribers.delete(sub); };
}
export function subscriberCount(tenantId, userId) {
    if (!tenantId)
        return subscribers.size;
    let n = 0;
    for (const s of subscribers)
        if (s.tenantId === tenantId && (!userId || s.userId === userId))
            n++;
    return n;
}
/**
 * Publish an event to one user across all API instances.
 * Persists first (so nothing is lost if the user is offline), then NOTIFYs.
 */
export async function publishToUser(tenantId, userId, kind, data) {
    // realtime_events is RLS-protected, so this must run through withTenant (which sets
    // app.tenant_id). control() does NOT set the tenant GUC, so an insert here would be
    // rejected by the row-level policy.
    const row = await withTenant(tenantId, async (c) => (await c.query(`INSERT INTO realtime_events (tenant_id, user_id, kind, payload) VALUES ($1,$2,$3,$4) RETURNING id`, [tenantId, userId, kind, JSON.stringify(data)])).rows[0]);
    const envelope = JSON.stringify({ tenantId, userId, kind, data: { ...data, eventId: String(row.id) } });
    try {
        // pg_notify() as a normal parameterised query — avoids the quoting pitfalls of NOTIFY.
        // NOTIFY is not row-scoped, so the plain pool is fine here.
        await control(c => c.query(`SELECT pg_notify($1, $2)`, [CHANNEL, envelope]));
    }
    catch (e) {
        console.error('pg_notify failed; falling back to local delivery only', e);
        deliverLocal(JSON.parse(envelope));
    }
    return { eventId: String(row.id), liveDelivery: subscriberCount(tenantId, userId) > 0 };
}
/** Mark an event delivered (client acks, or it was fetched on reconnect). */
export async function markDelivered(tenantId, eventId) {
    if (!/^\d+$/.test(String(eventId)))
        return; // ids are bigserial; ignore junk
    await withTenant(tenantId, c => c.query(`UPDATE realtime_events SET delivered=true WHERE tenant_id=$1 AND id=$2`, [tenantId, eventId]));
}
/** Undelivered recent events for a user — replayed when a browser (re)connects. */
export async function pendingEvents(tenantId, userId, limit = 5) {
    const rows = await withTenant(tenantId, async (c) => (await c.query(`SELECT id, kind, payload, created_at FROM realtime_events
     WHERE tenant_id=$1 AND user_id=$2 AND delivered=false
       AND created_at > now() - INTERVAL '10 minutes'
     ORDER BY id DESC LIMIT $3`, [tenantId, userId, limit])).rows);
    return rows.map((r) => ({ eventId: String(r.id), kind: r.kind, data: r.payload, createdAt: r.created_at }));
}
