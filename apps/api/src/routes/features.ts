import { Router } from 'express';
import { sendError } from '../util.js';
import { FEATURES, getEntitlements } from '../entitlements.js';

/**
 * Tenant-facing feature entitlements.
 *
 * The UI uses this to render paid capabilities as VISIBLE BUT LOCKED rather than hiding them —
 * a locked feature with a clear label is an upsell surface, whereas a hidden one is invisible
 * demand. Enforcement always happens server-side on the feature's own endpoints; this is
 * presentation only.
 */
export const featuresRouter = Router();

featuresRouter.get('/', async (req, res) => {
  try {
    const enabled = await getEntitlements(req.auth!.tenantId);
    const items = Object.values(FEATURES).map(f => ({
      key: f.key, label: f.label, description: f.description,
      paid: f.paid, enabled: !!enabled[f.key],
    }));
    res.json({ items, enabled });
  } catch (e) { sendError(res, e); }
});
