import { Router } from 'express';
import { control, withTenant, bypassRLS } from '../db.js';
import { err, sendError } from '../util.js';
import { requireHostPermission } from '../auth.js';
import { hostAudit } from './hostTeam.js';

/**
 * Per-customer cost / revenue / profitability ledger.
 *
 * WHY THIS EXISTS: per-user pricing means revenue is decoupled from the data a customer stores.
 * Without a per-tenant cost view you can be growing revenue and losing money on your heaviest
 * customers without noticing. This makes that visible per tenant and overall.
 *
 * TWO SOURCES OF COST DATA:
 *   manual — you enter your real invoices (AWS bill, provider bills, support time). Accurate,
 *            because only you know what you actually paid.
 *   auto   — derived from MEASURED usage (storage bytes, API calls, messages) using the rates
 *            in `cost_model`. Approximate but zero-effort, and good enough to spot outliers.
 *
 * Both are kept, and reports show them separately so an estimate is never mistaken for a fact.
 */
export const ledgerRouter = Router();

const CATEGORIES = ['hosting', 'database', 'storage', 'messaging', 'support', 'subscription', 'setup', 'other'];

// ---------------------------------------------------------------------------
// Cost model (the rates used for auto-derived costs)
// ---------------------------------------------------------------------------
ledgerRouter.get('/cost-model', async (req: any, res) => {
  try {
    requireHostPermission(req, 'viewBilling');
    const row = (await control(c => c.query(`SELECT * FROM cost_model WHERE id=1`))).rows[0];
    res.json(row);
  } catch (e) { sendError(res, e); }
});

ledgerRouter.patch('/cost-model', async (req: any, res) => {
  try {
    requireHostPermission(req, 'manageBilling');
    const { currency, fixedMonthlyInfra, costPerGbStorage, costPerMillionApiCalls, costPer1kMessages, notes } = req.body || {};
    const row = (await control(c => c.query(
      `UPDATE cost_model SET currency=COALESCE($1,currency),
         fixed_monthly_infra=COALESCE($2,fixed_monthly_infra),
         cost_per_gb_storage=COALESCE($3,cost_per_gb_storage),
         cost_per_million_api_calls=COALESCE($4,cost_per_million_api_calls),
         cost_per_1k_messages=COALESCE($5,cost_per_1k_messages),
         notes=COALESCE($6,notes), updated_at=now()
       WHERE id=1 RETURNING *`,
      [currency, fixedMonthlyInfra, costPerGbStorage, costPerMillionApiCalls, costPer1kMessages, notes]))).rows[0];
    await hostAudit(req.hostUser.id, 'cost_model.updated', 'cost_model', '1', req.body);
    res.json(row);
  } catch (e) { sendError(res, e); }
});

// ---------------------------------------------------------------------------
// Ledger entries
// ---------------------------------------------------------------------------
ledgerRouter.get('/tenants/:id/entries', async (req: any, res) => {
  try {
    requireHostPermission(req, 'viewBilling');
    const rows = (await control(c => c.query(
      `SELECT * FROM tenant_ledger WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500`,
      [req.params.id]))).rows;
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

ledgerRouter.post('/tenants/:id/entries', async (req: any, res) => {
  try {
    requireHostPermission(req, 'manageBilling');
    const { entryType, category, amount, currency = 'INR', periodStart, periodEnd,
            description, invoiceRef, isPaid = true, paidAt } = req.body || {};
    if (!['cost', 'revenue'].includes(entryType)) throw err(400, 'INVALID_VALUE', 'entryType must be cost|revenue');
    if (!CATEGORIES.includes(category)) throw err(400, 'INVALID_VALUE', `category must be one of ${CATEGORIES.join(', ')}`);
    if (amount == null || isNaN(Number(amount))) throw err(400, 'INVALID_VALUE', 'amount must be a number');

    const row = (await control(c => c.query(
      `INSERT INTO tenant_ledger (tenant_id, entry_type, category, amount, currency, period_start,
         period_end, description, source, invoice_ref, is_paid, paid_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10,$11,$12) RETURNING *`,
      [req.params.id, entryType, category, amount, currency, periodStart || null, periodEnd || null,
       description || null, invoiceRef || null, isPaid,
       isPaid ? (paidAt || new Date().toISOString()) : null, req.hostUser.id]))).rows[0];
    await hostAudit(req.hostUser.id, `ledger.${entryType}_added`, 'tenant', req.params.id, { category, amount, currency });
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

ledgerRouter.patch('/entries/:entryId', async (req: any, res) => {
  try {
    requireHostPermission(req, 'manageBilling');
    const { isPaid, paidAt, description, amount } = req.body || {};
    const row = (await control(c => c.query(
      `UPDATE tenant_ledger SET is_paid=COALESCE($2,is_paid),
         paid_at = CASE WHEN $2 IS TRUE THEN COALESCE($3, now()) WHEN $2 IS FALSE THEN NULL ELSE paid_at END,
         description=COALESCE($4,description), amount=COALESCE($5,amount)
       WHERE id=$1 RETURNING *`,
      [req.params.entryId, isPaid, paidAt || null, description, amount]))).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Ledger entry not found');
    await hostAudit(req.hostUser.id, 'ledger.entry_updated', 'ledger_entry', req.params.entryId, req.body);
    res.json(row);
  } catch (e) { sendError(res, e); }
});

ledgerRouter.delete('/entries/:entryId', async (req: any, res) => {
  try {
    requireHostPermission(req, 'manageBilling');
    await control(c => c.query(`DELETE FROM tenant_ledger WHERE id=$1`, [req.params.entryId]));
    await hostAudit(req.hostUser.id, 'ledger.entry_deleted', 'ledger_entry', req.params.entryId, null);
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

// ---------------------------------------------------------------------------
// Measured usage per tenant (what auto-cost is derived from)
// ---------------------------------------------------------------------------
/**
 * Real measured footprint for one tenant. Storage is computed from actual row counts times
 * average row width — approximate but consistent, and far cheaper than per-table pg_size calls
 * on a shared cluster.
 */
export async function measureTenantUsage(tenantId: string) {
  const counts = await withTenant(tenantId, async c => {
    const q = async (sql: string) => Number((await c.query(sql)).rows[0]?.n || 0);
    return {
      leads: await q(`SELECT COUNT(*)::bigint AS n FROM leads WHERE deleted_at IS NULL`),
      activities: await q(`SELECT COUNT(*)::bigint AS n FROM activities`),
      opportunities: await q(`SELECT COUNT(*)::bigint AS n FROM opportunities WHERE deleted_at IS NULL`),
      tasks: await q(`SELECT COUNT(*)::bigint AS n FROM tasks`),
      users: await q(`SELECT COUNT(*)::bigint AS n FROM users WHERE is_active`),
      files: await q(`SELECT COALESCE(SUM(size_bytes),0)::bigint AS n FROM files`),
      auditRows: await q(`SELECT COUNT(*)::bigint AS n FROM audit_log`),
      apiLogRows: await q(`SELECT COUNT(*)::bigint AS n FROM api_request_log`),
      messages: await q(`SELECT COUNT(*)::bigint AS n FROM message_log`),
    };
  });

  const apiCalls30d = Number((await control(c => c.query(
    `SELECT COALESCE(SUM(calls),0)::bigint AS n FROM api_usage_daily
     WHERE tenant_id=$1 AND day > CURRENT_DATE - 30`, [tenantId]))).rows[0].n);

  // Rough average bytes per row, from observed schema widths. Deliberately conservative.
  const estBytes =
    counts.leads * 1200 + counts.activities * 500 + counts.opportunities * 600 +
    counts.tasks * 300 + counts.auditRows * 1500 + counts.apiLogRows * 900 +
    counts.messages * 700 + counts.files;

  return { ...counts, apiCalls30d, estimatedBytes: estBytes, estimatedGb: estBytes / (1024 ** 3) };
}

ledgerRouter.get('/tenants/:id/usage', async (req: any, res) => {
  try {
    requireHostPermission(req, 'viewUsage');
    res.json(await measureTenantUsage(req.params.id));
  } catch (e) { sendError(res, e); }
});

/**
 * Auto-derive this month's cost for a tenant from measured usage + the cost model, and record it
 * as a `source='auto'` ledger entry (replacing any existing auto entry for the period, so
 * re-running is safe).
 */
ledgerRouter.post('/tenants/:id/auto-cost', async (req: any, res) => {
  try {
    requireHostPermission(req, 'manageBilling');
    const model = (await control(c => c.query(`SELECT * FROM cost_model WHERE id=1`))).rows[0];
    const usage = await measureTenantUsage(req.params.id);

    const activeTenants = Number((await control(c => c.query(
      `SELECT COUNT(*)::int AS n FROM tenants WHERE status='active'`))).rows[0].n) || 1;

    // Fixed infra is shared, so apportion it evenly — the honest simple model. (Weighting by
    // usage share is possible later, but even-split is defensible and easy to explain.)
    const infraShare = Number(model.fixed_monthly_infra) / activeTenants;
    const storageCost = usage.estimatedGb * Number(model.cost_per_gb_storage);
    const apiCost = (usage.apiCalls30d / 1_000_000) * Number(model.cost_per_million_api_calls);
    const msgCost = (usage.messages / 1000) * Number(model.cost_per_1k_messages);
    const total = infraShare + storageCost + apiCost + msgCost;

    const periodStart = new Date(); periodStart.setUTCDate(1);
    const ps = periodStart.toISOString().slice(0, 10);

    const row = await control(async c => {
      // Idempotent per period.
      await c.query(
        `DELETE FROM tenant_ledger WHERE tenant_id=$1 AND source='auto' AND period_start=$2`,
        [req.params.id, ps]);
      return (await c.query(
        `INSERT INTO tenant_ledger (tenant_id, entry_type, category, amount, currency, period_start,
           description, source, is_paid, created_by)
         VALUES ($1,'cost','hosting',$2,$3,$4,$5,'auto',true,$6) RETURNING *`,
        [req.params.id, total.toFixed(2), model.currency, ps,
         `Auto-derived: infra ${infraShare.toFixed(2)} + storage ${storageCost.toFixed(2)} (${usage.estimatedGb.toFixed(3)}GB) + api ${apiCost.toFixed(2)} (${usage.apiCalls30d} calls) + messaging ${msgCost.toFixed(2)}`,
         req.hostUser.id])).rows[0];
    });

    res.status(201).json({ entry: row, breakdown: { infraShare, storageCost, apiCost, msgCost, total }, usage });
  } catch (e) { sendError(res, e); }
});

// ---------------------------------------------------------------------------
// Profitability
// ---------------------------------------------------------------------------
/** Per-tenant P&L plus an overall roll-up — the "am I actually making money" view. */
ledgerRouter.get('/profitability', async (req: any, res) => {
  try {
    requireHostPermission(req, 'viewBilling');
    const rows = (await control(c => c.query(
      `SELECT t.id, t.code, t.name, t.status, t.created_at, p.code AS plan_code,
              COALESCE(SUM(CASE WHEN l.entry_type='cost' THEN l.amount END),0) AS total_cost,
              COALESCE(SUM(CASE WHEN l.entry_type='revenue' THEN l.amount END),0) AS total_revenue,
              COALESCE(SUM(CASE WHEN l.entry_type='revenue' AND l.is_paid THEN l.amount END),0) AS revenue_received,
              COALESCE(SUM(CASE WHEN l.entry_type='revenue' AND NOT l.is_paid THEN l.amount END),0) AS revenue_outstanding
       FROM tenants t
       LEFT JOIN plans p ON p.id = t.plan_id
       LEFT JOIN tenant_ledger l ON l.tenant_id = t.id
       GROUP BY t.id, p.code
       ORDER BY (COALESCE(SUM(CASE WHEN l.entry_type='revenue' AND l.is_paid THEN l.amount END),0)
                 - COALESCE(SUM(CASE WHEN l.entry_type='cost' THEN l.amount END),0)) ASC`))).rows;

    const items = rows.map((r: any) => {
      const cost = Number(r.total_cost), received = Number(r.revenue_received);
      const profit = received - cost;
      return {
        ...r,
        total_cost: cost, total_revenue: Number(r.total_revenue),
        revenue_received: received, revenue_outstanding: Number(r.revenue_outstanding),
        profit,
        // Margin against revenue (not cost) — the standard way to read it.
        marginPercent: received > 0 ? Number(((profit / received) * 100).toFixed(1)) : null,
        isLossMaking: profit < 0,
      };
    });

    const overall = items.reduce((a: any, r: any) => ({
      totalCost: a.totalCost + r.total_cost,
      totalRevenue: a.totalRevenue + r.total_revenue,
      revenueReceived: a.revenueReceived + r.revenue_received,
      revenueOutstanding: a.revenueOutstanding + r.revenue_outstanding,
    }), { totalCost: 0, totalRevenue: 0, revenueReceived: 0, revenueOutstanding: 0 });
    const overallProfit = overall.revenueReceived - overall.totalCost;

    res.json({
      items,
      overall: {
        ...overall,
        profit: overallProfit,
        marginPercent: overall.revenueReceived > 0
          ? Number(((overallProfit / overall.revenueReceived) * 100).toFixed(1)) : null,
        lossMakingTenants: items.filter((i: any) => i.isLossMaking).length,
        tenantCount: items.length,
      },
    });
  } catch (e) { sendError(res, e); }
});

// ---------------------------------------------------------------------------
// Usage-based upsell signals
// ---------------------------------------------------------------------------
/**
 * Tenants approaching a limit — the highest-converting upsell list in SaaS, because the customer
 * is already feeling the constraint. Derived from data we already collect, so it costs nothing.
 */
ledgerRouter.get('/upsell-signals', async (req: any, res) => {
  try {
    requireHostPermission(req, 'viewUsage');
    const tenants = (await control(c => c.query(
      `SELECT t.id, t.code, t.name, t.api_daily_quota_override, t.api_rate_override,
              p.api_daily_quota, p.code AS plan_code
       FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id
       WHERE t.status='active'`))).rows;

    const signals: any[] = [];
    for (const t of tenants) {
      const quota = t.api_daily_quota_override ?? t.api_daily_quota ?? 50000;
      const recent = (await control(c => c.query(
        `SELECT COALESCE(MAX(calls),0)::bigint AS peak, COALESCE(AVG(calls),0)::numeric AS avg
         FROM api_usage_daily WHERE tenant_id=$1 AND day > CURRENT_DATE - 7`, [t.id]))).rows[0];
      const peak = Number(recent.peak);
      const pct = quota > 0 ? (peak / quota) * 100 : 0;

      const reasons: string[] = [];
      if (pct >= 80) reasons.push(`Peak API usage is ${pct.toFixed(0)}% of their daily quota`);
      const throttled = Number((await control(c => c.query(
        `SELECT COUNT(*)::int AS n FROM api_request_log
         WHERE tenant_id=$1 AND status_code=429 AND created_at > now() - INTERVAL '7 days'`, [t.id]
      ).catch(() => ({ rows: [{ n: 0 }] })))).rows[0].n);
      if (throttled > 0) reasons.push(`${throttled} requests were rate-limited in the last 7 days`);

      const ent = (await control(c => c.query(
        `SELECT feature FROM tenant_entitlements WHERE tenant_id=$1 AND is_enabled`, [t.id]))).rows.map((r: any) => r.feature);
      if (!ent.includes('automation')) reasons.push('Automation is not enabled — a common first upgrade');

      if (reasons.length) {
        signals.push({
          tenantId: t.id, code: t.code, name: t.name, planCode: t.plan_code,
          peakDailyCalls: peak, quota, quotaUsedPercent: Number(pct.toFixed(1)),
          throttledLast7Days: throttled, reasons,
          priority: pct >= 95 || throttled > 10 ? 'high' : pct >= 80 ? 'medium' : 'low',
        });
      }
    }
    signals.sort((a, b) => b.quotaUsedPercent - a.quotaUsedPercent);
    res.json({ items: signals });
  } catch (e) { sendError(res, e); }
});
