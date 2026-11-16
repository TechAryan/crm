import { control } from './db.js';
import { config } from './config.js';

/**
 * Per-tenant API rate limiting and daily quota.
 *
 * WHY THIS EXISTS: every API call costs CPU, DB work and (for automation/custom actions)
 * outbound bandwidth. Without per-tenant limits, one customer's runaway integration or
 * import loop degrades the service for everyone — the classic noisy-neighbour failure. Limits
 * are also the monetization lever: the default is deliberately modest and the host admin
 * raises it for customers who pay for more volume.
 *
 * DESIGN: counting happens in ONE atomic Postgres statement per request that bumps both the
 * burst bucket and the daily counter and returns both. This is deliberately not an in-memory
 * limiter: with more than one API process, in-memory counters each allow the full limit, so
 * the effective limit silently becomes limit x processes. Correct multi-process counting
 * without adding Redis is worth one indexed upsert.
 *
 * Resolution order for limits: tenant override -> plan -> config default.
 */

export interface TenantLimits {
  ratePerWindow: number;
  burstSeconds: number;
  dailyQuota: number;
}

interface LimitsCacheEntry { limits: TenantLimits; at: number }
const limitsCache = new Map<string, LimitsCacheEntry>();
const LIMITS_CACHE_MS = 60_000;

/**
 * MULTI-PROCESS NOTE: like entitlements, the LIMITS cache is per-process (60s bound), so a limit
 * raised on one instance takes up to a minute to apply everywhere. That's fine — it only affects
 * the threshold, not the counting. The COUNTERS themselves are in Postgres and therefore exact
 * across all instances, which is the part that actually has to be correct.
 */
export function invalidateLimits(tenantId: string) { limitsCache.delete(tenantId); }

export async function getTenantLimits(tenantId: string): Promise<TenantLimits> {
  const hit = limitsCache.get(tenantId);
  if (hit && Date.now() - hit.at < LIMITS_CACHE_MS) return hit.limits;

  const row = (await control(c => c.query(
    `SELECT t.api_rate_override, t.api_burst_seconds, t.api_daily_quota_override,
            p.api_rate_per_sec, p.api_daily_quota
     FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id WHERE t.id=$1`, [tenantId]))).rows[0];

  const burstSeconds = row?.api_burst_seconds ?? config.defaultApiBurstSeconds;
  // The plan column is calls per SECOND, so scale it to the window length. Treating a
  // "25/sec" plan as "25 per 5s" would silently give customers 1/5th of what they bought.
  // A per-tenant override, by contrast, is expressed directly as calls per window.
  const planPerWindow = row?.api_rate_per_sec != null ? row.api_rate_per_sec * burstSeconds : null;
  const limits: TenantLimits = {
    ratePerWindow: row?.api_rate_override ?? planPerWindow ?? config.defaultApiRatePerWindow,
    burstSeconds,
    dailyQuota: row?.api_daily_quota_override ?? row?.api_daily_quota ?? config.defaultApiDailyQuota,
  };
  limitsCache.set(tenantId, { limits, at: Date.now() });
  return limits;
}

export interface QuotaResult {
  allowed: boolean;
  reason?: 'rate' | 'quota';
  windowCalls: number;
  dailyCalls: number;
  limits: TenantLimits;
  retryAfterSeconds: number;
}

/**
 * Count one API call and report whether it's allowed.
 * Single round trip: both counters are incremented and returned together.
 */
export async function consumeQuota(tenantId: string): Promise<QuotaResult> {
  const limits = await getTenantLimits(tenantId);
  const windowSize = Math.max(1, limits.burstSeconds);
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % windowSize);

  const row = (await control(c => c.query(
    `WITH burst AS (
       INSERT INTO api_rate_buckets (tenant_id, window_start, calls)
       VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, window_start) DO UPDATE SET calls = api_rate_buckets.calls + 1
       RETURNING calls
     ), daily AS (
       INSERT INTO api_usage_daily (tenant_id, day, calls)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (tenant_id, day) DO UPDATE SET calls = api_usage_daily.calls + 1
       RETURNING calls
     )
     SELECT (SELECT calls FROM burst) AS window_calls, (SELECT calls FROM daily) AS daily_calls`,
    [tenantId, windowStart]))).rows[0];

  const windowCalls = Number(row?.window_calls || 0);
  const dailyCalls = Number(row?.daily_calls || 0);
  const retryAfterSeconds = windowStart + windowSize - nowSec;

  if (windowCalls > limits.ratePerWindow)
    return { allowed: false, reason: 'rate', windowCalls, dailyCalls, limits, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  if (dailyCalls > limits.dailyQuota) {
    const secondsToMidnight = 86400 - (nowSec % 86400);
    return { allowed: false, reason: 'quota', windowCalls, dailyCalls, limits, retryAfterSeconds: secondsToMidnight };
  }
  return { allowed: true, windowCalls, dailyCalls, limits, retryAfterSeconds: 0 };
}

/**
 * Express middleware for authenticated tenant routes. Mount AFTER auth so the tenant is known.
 *
 * Fails OPEN on infrastructure errors: if the counter query itself fails we let the request
 * through rather than taking the whole API down over accounting. Rejecting real traffic
 * because a metering table hiccuped would be a worse outcome than briefly under-counting.
 */
export function tenantRateLimit() {
  return async (req: any, res: any, next: any) => {
    try {
      if (!req.auth?.tenantId) return next();
      const r = await consumeQuota(req.auth.tenantId);
      res.setHeader('X-RateLimit-Limit', String(r.limits.ratePerWindow));
      res.setHeader('X-RateLimit-Window', String(r.limits.burstSeconds));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, r.limits.ratePerWindow - r.windowCalls)));
      res.setHeader('X-Quota-Limit', String(r.limits.dailyQuota));
      res.setHeader('X-Quota-Used', String(r.dailyCalls));
      if (!r.allowed) {
        res.setHeader('Retry-After', String(r.retryAfterSeconds));
        return res.status(429).json({
          error: {
            code: r.reason === 'quota' ? 'DAILY_QUOTA_EXCEEDED' : 'RATE_LIMITED',
            message: r.reason === 'quota'
              ? `Daily API quota of ${r.limits.dailyQuota} calls exceeded. It resets at midnight UTC, or ask your account manager to raise it.`
              : `Rate limit exceeded: more than ${r.limits.ratePerWindow} calls in ${r.limits.burstSeconds}s. Retry in ${r.retryAfterSeconds}s, or ask your account manager to raise your limit.`,
            retryAfterSeconds: r.retryAfterSeconds,
          },
        });
      }
      next();
    } catch (e) {
      console.error('quota check failed (failing open)', e);
      next();
    }
  };
}

/** Sweep stale burst buckets. Called periodically; keeps the table tiny. */
export async function sweepRateBuckets() {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - 3600;
    await control(c => c.query(`DELETE FROM api_rate_buckets WHERE window_start < $1`, [cutoff]));
  } catch (e) { console.error('rate bucket sweep failed', e); }
}

let sweepTimer: NodeJS.Timeout | null = null;
export function startQuotaSweeper(intervalMs = 600_000) {
  sweepTimer = setInterval(sweepRateBuckets, intervalMs);
  sweepTimer.unref?.();
}
export function stopQuotaSweeper() { if (sweepTimer) clearInterval(sweepTimer); }
