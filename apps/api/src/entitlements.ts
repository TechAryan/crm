import { control } from './db.js';
import { err } from './util.js';

/**
 * Feature entitlements — which capabilities a tenant may use.
 *
 * Resolution order (most specific wins):
 *   1. tenant_entitlements row  (host-admin per-tenant unlock/lock)
 *   2. plans.features[feature]  (what the plan includes)
 *   3. FEATURES[feature].default
 *
 * Paid features stay VISIBLE but locked in the tenant UI (good upsell surface) and are
 * always enforced server-side — hiding a button without enforcing the endpoint is not a lock.
 */

export interface FeatureDef {
  key: string;
  label: string;
  description: string;
  paid: boolean;
  default: boolean;
}

export const FEATURES: Record<string, FeatureDef> = {
  automation: {
    key: 'automation', label: 'Automation', paid: true, default: false,
    description: 'Trigger-based workflow rules that update records and call external APIs.',
  },
  custom_actions: {
    key: 'custom_actions', label: 'Custom Action Buttons', paid: true, default: false,
    description: 'Admin-defined buttons on records that call your own APIs.',
  },
  telephony: {
    key: 'telephony', label: 'Telephony Connector', paid: true, default: false,
    description: 'Inbound call screen-pop and post-call data sync from any dialer.',
  },
  api_field_options: {
    key: 'api_field_options', label: 'API-sourced Dropdowns', paid: true, default: false,
    description: 'Populate dropdown fields live from your own API.',
  },
  page_builder: {
    key: 'page_builder', label: 'Landing Pages', paid: true, default: false,
    description: 'Template-based hosted landing pages that capture leads.',
  },
  custom_apps: {
    key: 'custom_apps', label: 'Custom Apps', paid: true, default: false,
    description: 'Embed your own web app as a tab or dashboard widget.',
  },
  batch_jobs: {
    key: 'batch_jobs', label: 'Batch Jobs', paid: true, default: false,
    description: 'Scheduled and bulk background jobs over large record sets.',
  },
  payments: {
    key: 'payments', label: 'Payments', paid: true, default: false,
    description: 'Generate payment links from records using your own payment gateway, and mark them paid automatically.',
  },
  messaging: {
    key: 'messaging', label: 'Messaging', paid: true, default: false,
    description: 'Send email/SMS/WhatsApp through your own provider account, with templates and mail-merge.',
  },
  extended_retention: {
    key: 'extended_retention', label: 'Extended Log Retention', paid: true, default: false,
    description: 'Keep API logs, audit history and message logs for longer than the standard period.',
  },
  // Included for everyone — listed so the registry is the single source of truth.
  webhooks: {
    key: 'webhooks', label: 'Webhooks', paid: false, default: true,
    description: 'Outbound HMAC-signed event delivery.',
  },
  smart_views: {
    key: 'smart_views', label: 'Smart Views', paid: false, default: true,
    description: 'Saved filters and column sets.',
  },
};

interface CacheEntry { map: Record<string, boolean>; at: number }
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 30_000;

/**
 * MULTI-PROCESS NOTE: this cache is per-process, so invalidateEntitlements() only clears the
 * instance that handled the unlock request. Other instances keep a stale value for up to
 * CACHE_MS (30s). That is an accepted bound, not an oversight: entitlement changes are rare
 * administrative actions, and 30 seconds of staleness on a feature flag is harmless — whereas
 * a DB read on every permission check would not be. Enforcement itself is always server-side,
 * so the worst case is a paid feature staying locked for another few seconds.
 */
export function invalidateEntitlements(tenantId: string) { cache.delete(tenantId); }

/** Resolve every feature flag for a tenant (cached briefly — these change rarely). */
export async function getEntitlements(tenantId: string): Promise<Record<string, boolean>> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.map;

  const map: Record<string, boolean> = {};
  for (const f of Object.values(FEATURES)) map[f.key] = f.default;

  const rows = await control(async c => {
    const plan = (await c.query(
      `SELECT p.features FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id=$1`, [tenantId])).rows[0];
    const overrides = (await c.query(
      `SELECT feature, is_enabled FROM tenant_entitlements WHERE tenant_id=$1`, [tenantId])).rows;
    return { planFeatures: plan?.features || {}, overrides };
  });

  for (const [k, v] of Object.entries(rows.planFeatures)) if (k in map) map[k] = !!v;
  for (const o of rows.overrides) if (o.feature in map) map[o.feature] = !!o.is_enabled;

  cache.set(tenantId, { map, at: Date.now() });
  return map;
}

export async function hasFeature(tenantId: string, feature: string): Promise<boolean> {
  const map = await getEntitlements(tenantId);
  return !!map[feature];
}

/** Express middleware: block a route unless the tenant is entitled to the feature. */
export function requireFeature(feature: string) {
  return async (req: any, res: any, next: any) => {
    try {
      if (!(await hasFeature(req.auth.tenantId, feature))) {
        const def = FEATURES[feature];
        return res.status(402).json({
          error: {
            code: 'FEATURE_NOT_ENABLED',
            message: `${def?.label || feature} is not enabled on your plan. Contact your account manager to unlock it.`,
            feature,
          },
        });
      }
      next();
    } catch (e) { next(e); }
  };
}

/** Throwing variant for use inside handlers/services. */
export async function assertFeature(tenantId: string, feature: string) {
  if (!(await hasFeature(tenantId, feature))) {
    const def = FEATURES[feature];
    throw err(402, 'FEATURE_NOT_ENABLED', `${def?.label || feature} is not enabled on your plan.`);
  }
}
