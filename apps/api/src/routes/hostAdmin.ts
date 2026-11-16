import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { control, withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { createTenant } from '../provisioning.js';
import { FEATURES, getEntitlements, invalidateEntitlements } from '../entitlements.js';
import { getTenantLimits, invalidateLimits } from '../quota.js';
import { RETENTION_DEFAULTS } from '../retention.js';
import { invalidateIpCache } from '../auth.js';

export const hostAdminRouter = Router();

function requireRole(req: any, roles: string[]) {
  if (!roles.includes(req.hostUser.role)) throw err(403, 'FORBIDDEN', `Requires role: ${roles.join('/')}`);
}

// ---------- Feature entitlements (unlock paid features per tenant) ----------
// This is the "unlock from admin panel" control: paid connectors/features are visible but
// locked in the tenant UI until enabled here (or included in their plan).
hostAdminRouter.get('/tenants/:id/entitlements', async (req, res) => {
  try {
    const data = await control(async c => {
      const plan = (await c.query(
        `SELECT p.code, p.features FROM tenants t JOIN plans p ON p.id=t.plan_id WHERE t.id=$1`, [req.params.id])).rows[0];
      const overrides = (await c.query(
        `SELECT feature, is_enabled, note, updated_at FROM tenant_entitlements WHERE tenant_id=$1 ORDER BY feature`,
        [req.params.id])).rows;
      return { plan, overrides };
    });
    if (!data.plan) throw err(404, 'NOT_FOUND', 'Tenant not found');
    const enabled = await getEntitlements(req.params.id);
    res.json({
      planCode: data.plan.code,
      planFeatures: data.plan.features || {},
      overrides: data.overrides,
      effective: enabled,
      registry: Object.values(FEATURES),
    });
  } catch (e) { sendError(res, e); }
});

hostAdminRouter.put('/tenants/:id/entitlements/:feature', async (req, res) => {
  try {
    requireRole(req, ['owner', 'admin']);
    const { feature } = req.params;
    if (!FEATURES[feature]) throw err(400, 'UNKNOWN_FEATURE', `Unknown feature: ${feature}. Known: ${Object.keys(FEATURES).join(', ')}`);
    const { isEnabled, note } = req.body || {};
    if (typeof isEnabled !== 'boolean') throw err(400, 'MISSING_FIELDS', 'isEnabled (boolean) required');
    const row = await control(async c => (await c.query(
      `INSERT INTO tenant_entitlements (tenant_id, feature, is_enabled, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled=EXCLUDED.is_enabled, note=EXCLUDED.note,
         updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING *`, [req.params.id, feature, isEnabled, note || null, req.hostUser.id])).rows[0]);
    invalidateEntitlements(req.params.id);   // cached for 30s — clear so the change is immediate
    res.json(row);
  } catch (e) { sendError(res, e); }
});

// ---------- API limits (rate + daily quota) per tenant ----------
// This is the "sell them more volume" lever: the default is modest, and a paying customer's
// limit is raised here. Enforced by quota.ts on every authenticated tenant API call.
hostAdminRouter.get('/tenants/:id/limits', async (req, res) => {
  try {
    const row = (await control(c => c.query(
      `SELECT t.api_rate_override, t.api_burst_seconds, t.api_daily_quota_override, t.ui_version,
              p.code AS plan_code, p.api_rate_per_sec, p.api_daily_quota
       FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id WHERE t.id=$1`, [req.params.id]))).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Tenant not found');
    const effective = await getTenantLimits(req.params.id);
    const today = (await control(c => c.query(
      `SELECT calls FROM api_usage_daily WHERE tenant_id=$1 AND day=CURRENT_DATE`, [req.params.id]))).rows[0];
    res.json({ ...row, effective, usageToday: today?.calls || 0 });
  } catch (e) { sendError(res, e); }
});

hostAdminRouter.patch('/tenants/:id/limits', async (req, res) => {
  try {
    requireRole(req, ['owner', 'admin']);
    const { apiRateOverride, apiBurstSeconds, apiDailyQuotaOverride } = req.body || {};
    for (const [k, v] of Object.entries({ apiRateOverride, apiBurstSeconds, apiDailyQuotaOverride })) {
      if (v !== undefined && v !== null && (!Number.isInteger(v) || (v as number) < 1))
        throw err(400, 'INVALID_VALUE', `${k} must be a positive integer or null to clear`);
    }
    const row = (await control(c => c.query(
      `UPDATE tenants SET
         api_rate_override = CASE WHEN $2::boolean THEN $3::int ELSE api_rate_override END,
         api_burst_seconds = CASE WHEN $4::boolean THEN $5::int ELSE api_burst_seconds END,
         api_daily_quota_override = CASE WHEN $6::boolean THEN $7::int ELSE api_daily_quota_override END,
         updated_at = now()
       WHERE id=$1
       RETURNING api_rate_override, api_burst_seconds, api_daily_quota_override`,
      [req.params.id,
       apiRateOverride !== undefined, apiRateOverride ?? null,
       apiBurstSeconds !== undefined, apiBurstSeconds ?? null,
       apiDailyQuotaOverride !== undefined, apiDailyQuotaOverride ?? null]))).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Tenant not found');
    invalidateLimits(req.params.id);   // cached 60s — clear so the change applies immediately
    res.json({ ...row, effective: await getTenantLimits(req.params.id) });
  } catch (e) { sendError(res, e); }
});

// ---------- UI version (staged rollout of a new interface) ----------
hostAdminRouter.patch('/tenants/:id/ui-version', async (req, res) => {
  try {
    requireRole(req, ['owner', 'admin']);
    const { uiVersion } = req.body || {};
    if (!Number.isInteger(uiVersion) || uiVersion < 1 || uiVersion > 10)
      throw err(400, 'INVALID_VALUE', 'uiVersion must be an integer between 1 and 10');
    const row = (await control(c => c.query(
      `UPDATE tenants SET ui_version=$2, updated_at=now() WHERE id=$1 RETURNING id, code, ui_version`,
      [req.params.id, uiVersion]))).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Tenant not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

// ---------- Demo data (for sales demos and trials) ----------
// Selling from an empty CRM is much harder than selling from one that looks alive: the funnel,
// trend and "needs attention" panels are invisible without data.
hostAdminRouter.post('/tenants/:id/demo-data', async (req, res) => {
  try {
    requireRole(req, ['owner', 'admin']);
    const { leadCount = 250, days = 90, seed = 42 } = req.body || {};
    if (!Number.isInteger(leadCount) || leadCount < 1 || leadCount > 5000)
      throw err(400, 'INVALID_VALUE', 'leadCount must be an integer between 1 and 5000');
    const t = (await control(c => c.query(`SELECT id, code, is_demo FROM tenants WHERE id=$1`, [req.params.id]))).rows[0];
    if (!t) throw err(404, 'NOT_FOUND', 'Tenant not found');

    const { generateDemoData } = await import('../demoData.js');
    const counts = await generateDemoData(req.params.id, { leadCount, days, seed });
    await control(c => c.query(`UPDATE tenants SET is_demo=true WHERE id=$1`, [req.params.id]));
    res.status(201).json({ tenant: t.code, generated: counts });
  } catch (e) { sendError(res, e); }
});

// ---------- Per-tenant IP allowlist ----------
hostAdminRouter.get('/tenants/:id/ip-allowlist', async (req, res) => {
  try {
    const row = (await control(c => c.query(
      `SELECT ip_allowlist_enabled, ip_allowlist FROM tenants WHERE id=$1`, [req.params.id]))).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Tenant not found');
    res.json({ enabled: row.ip_allowlist_enabled, allowlist: row.ip_allowlist });
  } catch (e) { sendError(res, e); }
});

hostAdminRouter.put('/tenants/:id/ip-allowlist', async (req, res) => {
  try {
    requireRole(req, ['owner', 'admin']);
    const { enabled, allowlist } = req.body || {};
    if (allowlist !== undefined && !Array.isArray(allowlist))
      throw err(400, 'INVALID_VALUE', 'allowlist must be an array of IPs or CIDR ranges');
    // Validate each entry so a typo can't silently lock a customer out.
    for (const entry of allowlist || []) {
      const s = String(entry).trim();
      const [ip, bits] = s.split('/');
      const octets = ip.split('.');
      const validV4 = octets.length === 4 && octets.every(o => /^\d+$/.test(o) && +o >= 0 && +o <= 255);
      const validBits = bits === undefined || (/^\d+$/.test(bits) && +bits >= 0 && +bits <= 32);
      if (!validV4 || !validBits) throw err(400, 'INVALID_VALUE', `'${entry}' is not a valid IPv4 address or CIDR range`);
    }
    if (enabled === true && (!allowlist || allowlist.length === 0))
      throw err(400, 'EMPTY_ALLOWLIST', 'Enabling the allowlist with no entries would lock the tenant out — add at least one IP.');

    const row = (await control(c => c.query(
      `UPDATE tenants SET ip_allowlist_enabled=COALESCE($2,ip_allowlist_enabled),
         ip_allowlist=COALESCE($3,ip_allowlist), updated_at=now()
       WHERE id=$1 RETURNING ip_allowlist_enabled, ip_allowlist`,
      [req.params.id, enabled, allowlist ? JSON.stringify(allowlist) : null]))).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Tenant not found');
    invalidateIpCache(req.params.id);
    res.json({ enabled: row.ip_allowlist_enabled, allowlist: row.ip_allowlist });
  } catch (e) { sendError(res, e); }
});

// ---------- Log retention (billable limit) ----------
// Longer retention genuinely costs us storage, so it's sold rather than self-served. Tenants can
// see their retention; only the host admin can raise it.
hostAdminRouter.get('/tenants/:id/retention', async (req, res) => {
  try {
    const row = (await control(c => c.query(`SELECT settings->'retention' AS retention FROM tenants WHERE id=$1`, [req.params.id]))).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Tenant not found');
    // Rough storage picture, so you can see what a retention change is actually costing.
    const usage = await withTenant(req.params.id, async c => ({
      apiLogRows: (await c.query(`SELECT COUNT(*)::int AS n FROM api_request_log`)).rows[0].n,
      auditRows: (await c.query(`SELECT COUNT(*)::int AS n FROM audit_log`)).rows[0].n,
      messageRows: (await c.query(`SELECT COUNT(*)::int AS n FROM message_log`)).rows[0].n,
    }));
    res.json({ retention: { ...RETENTION_DEFAULTS, ...(row.retention || {}) }, usage, defaults: RETENTION_DEFAULTS });
  } catch (e) { sendError(res, e); }
});

hostAdminRouter.patch('/tenants/:id/retention', async (req, res) => {
  try {
    requireRole(req, ['owner', 'admin']);
    const allowed = Object.keys(RETENTION_DEFAULTS);
    const patch: Record<string, any> = {};
    for (const k of allowed) {
      if (!(k in (req.body || {}))) continue;
      const v = req.body[k];
      // null is meaningful: "keep forever".
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 3650))
        throw err(400, 'INVALID_VALUE', `${k} must be null (keep forever) or an integer 1-3650 days`);
      patch[k] = v;
    }
    if (!Object.keys(patch).length) throw err(400, 'MISSING_FIELDS', `Provide at least one of: ${allowed.join(', ')}`);
    const row = (await control(c => c.query(
      `UPDATE tenants SET settings = jsonb_set(settings, '{retention}',
         COALESCE(settings->'retention','{}'::jsonb) || $2::jsonb, true), updated_at=now()
       WHERE id=$1 RETURNING settings->'retention' AS retention`,
      [req.params.id, JSON.stringify(patch)]))).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Tenant not found');
    res.json({ retention: row.retention });
  } catch (e) { sendError(res, e); }
});

/** Trigger the retention purge on demand (normally runs nightly). */
hostAdminRouter.post('/retention/run', async (req, res) => {
  try {
    requireRole(req, ['owner', 'admin']);
    const { runRetentionSweep } = await import('../retention.js');
    res.json(await runRetentionSweep());
  } catch (e) { sendError(res, e); }
});

// ---------- Plans ----------
hostAdminRouter.get('/plans', async (req, res) => {
  try { res.json({ items: (await control(c => c.query(`SELECT * FROM plans ORDER BY api_daily_quota`))).rows }); }
  catch (e) { sendError(res, e); }
});
hostAdminRouter.post('/plans', async (req, res) => {
  try {
    requireRole(req, ['owner']);
    const { code, name, maxUsers = 10, apiDailyQuota = 50000, apiRatePerSec = 10, features = {} } = req.body || {};
    if (!code || !name) throw err(400, 'MISSING_FIELDS', 'code, name required');
    const row = (await control(c => c.query(
      `INSERT INTO plans (code, name, max_users, api_daily_quota, api_rate_per_sec, features) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [code, name, maxUsers, apiDailyQuota, apiRatePerSec, JSON.stringify(features)]))).rows[0];
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

// ---------- Partners ----------
hostAdminRouter.get('/partners', async (req, res) => {
  try { res.json({ items: (await control(c => c.query(`SELECT * FROM partners ORDER BY created_at DESC`))).rows }); }
  catch (e) { sendError(res, e); }
});
hostAdminRouter.post('/partners', async (req, res) => {
  try {
    requireRole(req, ['owner', 'support']);
    const { name, contactEmail, branding = {} } = req.body || {};
    if (!name) throw err(400, 'MISSING_FIELDS', 'name required');
    const row = (await control(c => c.query(`INSERT INTO partners (name, contact_email, branding) VALUES ($1,$2,$3) RETURNING *`,
      [name, contactEmail || null, JSON.stringify(branding)]))).rows[0];
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

// ---------- Tenants ----------
hostAdminRouter.get('/tenants', async (req, res) => {
  try {
    const scoped = req.hostUser.role === 'partner';
    const rows = await control(c => c.query(
      scoped
        ? `SELECT t.*, p.code AS plan_code FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id WHERE t.partner_id=$1 ORDER BY t.created_at DESC`
        : `SELECT t.*, p.code AS plan_code FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id ORDER BY t.created_at DESC`,
      scoped ? [req.hostUser.partner_id] : []));
    res.json({ items: rows.rows });
  } catch (e) { sendError(res, e); }
});

hostAdminRouter.get('/templates', async (_req, res) => {
  try {
    const { TEMPLATES } = await import('../templates.js');
    res.json({ items: Object.values(TEMPLATES).map(t => ({ code: t.code, name: t.name, description: t.description })) });
  } catch (e) { sendError(res, e); }
});

hostAdminRouter.post('/tenants', async (req, res) => {
  try {
    requireRole(req, ['owner', 'support', 'partner']);
    const { name, subdomain, planCode = 'starter', isTest = false, region = 'in', partnerId, branding = {},
            adminEmail, adminName = 'Admin', adminPassword, template = 'generic' } = req.body || {};
    if (!name || !subdomain) throw err(400, 'MISSING_FIELDS', 'name, subdomain required');
    if (!adminEmail) throw err(400, 'MISSING_FIELDS', 'adminEmail required to bootstrap the tenant');
    const effectivePartnerId = req.hostUser.role === 'partner' ? req.hostUser.partner_id : (partnerId || null);

    // adminPassword is optional: omit it and we generate a strong temp password + a one-time
    // set-password link (24h) for you to share with the customer — no SMTP is wired up yet.
    const tenant: any = await createTenant({
      name, subdomain, planCode, isTest, region, partnerId: effectivePartnerId, branding, adminEmail, adminName, adminPassword, template,
    });

    res.status(201).json({
      ...tenant, loginUrl: `https://${tenant.subdomain}.yourcrm.app/login`,
      ...(tenant.generatedCredentials ? { generatedCredentials: tenant.generatedCredentials } : {}),
    });
  } catch (e) { sendError(res, e); }
});

hostAdminRouter.patch('/tenants/:id', async (req, res) => {
  try {
    requireRole(req, ['owner', 'support']);
    const { status, planCode, branding } = req.body || {};
    let planId: string | undefined;
    if (planCode) {
      const p = (await control(c => c.query(`SELECT id FROM plans WHERE code=$1`, [planCode]))).rows[0];
      if (!p) throw err(400, 'UNKNOWN_PLAN', `Unknown plan: ${planCode}`);
      planId = p.id;
    }
    const row = (await control(c => c.query(
      `UPDATE tenants SET status=COALESCE($2,status), plan_id=COALESCE($3,plan_id), branding=COALESCE($4,branding), updated_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id, status, planId, branding ? JSON.stringify(branding) : null]))).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Tenant not found');
    await control(c => c.query(`INSERT INTO host_audit_log (host_user_id, action, target_type, target_id, detail) VALUES ($1,$2,'tenant',$3,$4)`,
      [req.hostUser.id, 'tenant.updated', row.id, JSON.stringify(req.body)]));
    res.json(row);
  } catch (e) { sendError(res, e); }
});

hostAdminRouter.get('/tenants/:id/usage', async (req, res) => {
  try {
    const rows = await control(c => c.query(`SELECT * FROM api_usage_daily WHERE tenant_id=$1 ORDER BY day DESC LIMIT 30`, [req.params.id]));
    const counts = await withTenant(req.params.id, async c => {
      const l = await c.query(`SELECT COUNT(*) FROM leads WHERE deleted_at IS NULL`);
      const u = await c.query(`SELECT COUNT(*) FROM users WHERE is_active`);
      return { leads: Number(l.rows[0].count), activeUsers: Number(u.rows[0].count) };
    });
    res.json({ apiUsage: rows.rows, ...counts });
  } catch (e) { sendError(res, e); }
});

// ---------- Login-as (impersonation, audited) ----------
hostAdminRouter.post('/tenants/:id/login-as', async (req, res) => {
  try {
    requireRole(req, ['owner', 'support']);
    const { userEmail } = req.body || {};
    const tenant = (await control(c => c.query(`SELECT * FROM tenants WHERE id=$1`, [req.params.id]))).rows[0];
    if (!tenant) throw err(404, 'NOT_FOUND', 'Tenant not found');
    const user = await withTenant(tenant.id, async c => {
      const q = userEmail
        ? await c.query(`SELECT id, email FROM users WHERE lower(email)=lower($1)`, [userEmail])
        : await c.query(`SELECT u.id, u.email FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='Admin' ORDER BY u.created_at LIMIT 1`);
      return q.rows[0];
    });
    if (!user) throw err(404, 'NOT_FOUND', 'No matching tenant user');
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../config.js');
    const token = jwt.default.sign({ sub: user.id, ten: tenant.id, tc: tenant.code, typ: 'tenant' }, config.jwtSecret, { expiresIn: '2h' });
    await control(c => c.query(`INSERT INTO host_audit_log (host_user_id, action, target_type, target_id, detail) VALUES ($1,'login_as','tenant',$2,$3)`,
      [req.hostUser.id, tenant.id, JSON.stringify({ asUser: user.email })]));
    res.json({ token, tenantCode: tenant.code, asUser: user.email });
  } catch (e) { sendError(res, e); }
});

// ---------- Host users ----------
hostAdminRouter.get('/host-users', async (req, res) => {
  try {
    requireRole(req, ['owner']);
    res.json({ items: (await control(c => c.query(`SELECT id, email, name, role, partner_id, is_active FROM host_users ORDER BY created_at`))).rows });
  } catch (e) { sendError(res, e); }
});
hostAdminRouter.post('/host-users', async (req, res) => {
  try {
    requireRole(req, ['owner']);
    const { email, name, password, role = 'support', partnerId } = req.body || {};
    if (!email || !name || !password) throw err(400, 'MISSING_FIELDS', 'email, name, password required');
    const hash = await bcrypt.hash(password, 10);
    const row = (await control(c => c.query(
      `INSERT INTO host_users (email, name, password_hash, role, partner_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role`,
      [email.toLowerCase(), name, hash, role, partnerId || null]))).rows[0];
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});
