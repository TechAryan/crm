import { bypassRLS, withTenant } from './db.js';

/**
 * Retention purge — deletes aged log data per tenant configuration.
 *
 * WHY THIS MATTERS COMMERCIALLY: log volume is the fastest-growing cost in a CRM (API logs,
 * audit trails, automation traces). Keeping everything forever for everyone would make the
 * cheapest customer as expensive as the largest. So each category has a default retention, and
 * longer retention is a paid upgrade set from the admin panel. That's honest pricing — longer
 * history genuinely costs more storage.
 *
 * DEFAULTS (tenants.settings.retention):
 *   recordAuditDays      null  -> keep forever. Who changed a lead/opportunity/activity is the
 *                                 compliance-relevant trail; deleting it by default would be wrong.
 *   settingsAuditDays    7     -> who changed configuration
 *   apiLogDays           7     -> request/response debugging
 *   messageLogDays       90    -> email/SMS/WhatsApp sends
 *   automationLogDays    30    -> automation execution traces
 *   outboundCallLogDays  30    -> outbound HTTP calls
 *
 * Deletes are chunked so a large backlog can't hold long locks or blow up WAL — an unbounded
 * `DELETE FROM ... WHERE created_at < ...` on a big table is a classic way to stall production.
 */

const CHUNK = 5000;

export interface RetentionConfig {
  recordAuditDays: number | null;
  settingsAuditDays: number | null;
  apiLogDays: number | null;
  messageLogDays: number | null;
  automationLogDays: number | null;
  outboundCallLogDays: number | null;
}

export const RETENTION_DEFAULTS: RetentionConfig = {
  recordAuditDays: null,
  settingsAuditDays: 7,
  apiLogDays: 7,
  messageLogDays: 90,
  automationLogDays: 30,
  outboundCallLogDays: 30,
};

/** Actions considered "settings/configuration" rather than record changes. */
const SETTINGS_ACTION_PREFIXES = [
  'settings.', 'role.', 'permission_set.', 'field.', 'stage.', 'source.', 'activity_type.',
  'opportunity_type.', 'form.', 'connector.', 'webhook.', 'automation_rule.', 'custom_action.',
  'widget.', 'branding.', 'distribution_rule.', 'user.', 'api_key.', 'template.', 'smart_view.',
];

/** Delete in bounded chunks; returns how many rows went. */
async function purgeChunked(
  tenantId: string, sql: string, params: any[]
): Promise<number> {
  let total = 0;
  for (let i = 0; i < 200; i++) {          // hard cap: at most 1M rows per table per run
    const r = await withTenant(tenantId, c => c.query(sql, params));
    const n = r.rowCount || 0;
    total += n;
    if (n < CHUNK) break;
  }
  return total;
}

export async function purgeTenant(tenantId: string, cfg: RetentionConfig): Promise<Record<string, number>> {
  const out: Record<string, number> = {};

  if (cfg.apiLogDays != null) {
    out.apiLogs = await purgeChunked(tenantId,
      `DELETE FROM api_request_log WHERE id IN (
         SELECT id FROM api_request_log WHERE created_at < now() - ($1 || ' days')::interval LIMIT ${CHUNK})`,
      [String(cfg.apiLogDays)]);
  }

  if (cfg.settingsAuditDays != null) {
    // Only configuration-change rows; record history is governed separately below.
    const prefixes = SETTINGS_ACTION_PREFIXES.map(p => `${p}%`);
    out.settingsAudit = await purgeChunked(tenantId,
      `DELETE FROM audit_log WHERE id IN (
         SELECT id FROM audit_log
         WHERE created_at < now() - ($1 || ' days')::interval
           AND action LIKE ANY($2::text[]) LIMIT ${CHUNK})`,
      [String(cfg.settingsAuditDays), prefixes]);
  }

  if (cfg.recordAuditDays != null) {
    const prefixes = SETTINGS_ACTION_PREFIXES.map(p => `${p}%`);
    out.recordAudit = await purgeChunked(tenantId,
      `DELETE FROM audit_log WHERE id IN (
         SELECT id FROM audit_log
         WHERE created_at < now() - ($1 || ' days')::interval
           AND NOT (action LIKE ANY($2::text[])) LIMIT ${CHUNK})`,
      [String(cfg.recordAuditDays), prefixes]);
  }

  if (cfg.messageLogDays != null) {
    out.messageLogs = await purgeChunked(tenantId,
      `DELETE FROM message_log WHERE id IN (
         SELECT id FROM message_log WHERE created_at < now() - ($1 || ' days')::interval LIMIT ${CHUNK})`,
      [String(cfg.messageLogDays)]);
  }

  if (cfg.automationLogDays != null) {
    out.automationLogs = await purgeChunked(tenantId,
      `DELETE FROM automation_executions WHERE id IN (
         SELECT id FROM automation_executions WHERE created_at < now() - ($1 || ' days')::interval LIMIT ${CHUNK})`,
      [String(cfg.automationLogDays)]);
  }

  if (cfg.outboundCallLogDays != null) {
    out.outboundCalls = await purgeChunked(tenantId,
      `DELETE FROM outbound_calls WHERE id IN (
         SELECT id FROM outbound_calls WHERE created_at < now() - ($1 || ' days')::interval LIMIT ${CHUNK})`,
      [String(cfg.outboundCallLogDays)]);
  }

  // Realtime events are ephemeral by nature — always short-lived.
  out.realtimeEvents = await purgeChunked(tenantId,
    `DELETE FROM realtime_events WHERE id IN (
       SELECT id FROM realtime_events WHERE created_at < now() - INTERVAL '2 days' LIMIT ${CHUNK})`,
    []);

  return out;
}

export function resolveRetention(settings: any): RetentionConfig {
  const r = settings?.retention || {};
  return {
    recordAuditDays: r.recordAuditDays ?? RETENTION_DEFAULTS.recordAuditDays,
    settingsAuditDays: r.settingsAuditDays ?? RETENTION_DEFAULTS.settingsAuditDays,
    apiLogDays: r.apiLogDays ?? RETENTION_DEFAULTS.apiLogDays,
    messageLogDays: r.messageLogDays ?? RETENTION_DEFAULTS.messageLogDays,
    automationLogDays: r.automationLogDays ?? RETENTION_DEFAULTS.automationLogDays,
    outboundCallLogDays: r.outboundCallLogDays ?? RETENTION_DEFAULTS.outboundCallLogDays,
  };
}

/** Sweep every active tenant. Called nightly by the scheduler. */
export async function runRetentionSweep(): Promise<{ tenants: number; deleted: Record<string, number> }> {
  const tenants = await bypassRLS(c => c.query(
    `SELECT id, settings FROM tenants WHERE status='active'`));
  const totals: Record<string, number> = {};
  for (const t of tenants.rows) {
    try {
      const res = await purgeTenant(t.id, resolveRetention(t.settings));
      for (const [k, v] of Object.entries(res)) totals[k] = (totals[k] || 0) + v;
    } catch (e) {
      // One tenant's purge failing must not stop the rest.
      console.error(`retention sweep failed for tenant ${t.id}`, e);
    }
  }
  return { tenants: tenants.rowCount || 0, deleted: totals };
}
