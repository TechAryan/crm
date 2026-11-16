/**
 * End-to-end smoke test. Starts the API in-process (embedded/external DB per env),
 * exercises: tenant creation, login, custom field creation, distribution rule,
 * lead capture -> auto distribution -> activity -> webhook delivery, permission
 * enforcement (sales user cannot delete), API key delete-scope enforcement,
 * and cross-tenant isolation (tenant B cannot see tenant A's leads).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { initDb, stopDb, control } from '../src/db.js';
import { createTenant } from '../src/provisioning.js';
import { totpNow } from '../src/totp.js';

const results: { name: string; ok: boolean; detail?: string }[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`);
}
function assert(name: string, cond: boolean, detail?: string) { record(name, !!cond, detail); }

async function req(base: string, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const url = base + path;
  const resp = await fetch(url, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await resp.json(); } catch { /* no body */ }
  return { status: resp.status, json };
}

/** Run a raw query inside a tenant's RLS context (for asserting on tables with no read API). */
async function withTenantHelper(tenantId: string, sql: string, params: any[] = []): Promise<any[]> {
  const { withTenant } = await import('../src/db.js');
  return withTenant(tenantId, async c => (await c.query(sql, params)).rows);
}

/** Raw query against control-plane tables (no RLS) for the same purpose. */
async function controlHelper(sql: string, params: any[] = []): Promise<any[]> {
  const { control } = await import('../src/db.js');
  return control(async c => (await c.query(sql, params)).rows);
}

async function main() {
  process.env.DB_MODE = process.env.DB_MODE || 'embedded';

  /**
   * Start from a CLEAN database every run.
   *
   * WHY THIS IS ESSENTIAL, NOT COSMETIC: the embedded Postgres is `persistent: true`, and this
   * suite creates tenants with FIXED subdomains ('acme-e2e', 'beta-e2e', ...). `tenants.subdomain`
   * is UNIQUE, so a second run against a surviving database fails on a duplicate-key violation —
   * which surfaces as an opaque "INTERNAL server error" on the very first tenant, and every later
   * check then cascades because there is no tenant to log into.
   *
   * That made the suite pass exactly once and fail forever after, unless the caller happened to
   * delete the data directory first. Tests must be repeatable without the caller knowing a ritual,
   * so the suite now owns its own clean state.
   *
   * Set E2E_KEEP_DB=1 to skip the wipe when you want to inspect the database after a failure.
   */
  /**
   * The suite uses its OWN data directory, separate from the one `npm run dev:api` uses.
   *
   * It previously shared the default `nexcrm-embedded-pgdata`, which meant the wipe below
   * destroyed the developer's local database. Because the pre-push hook runs this suite, the
   * effect was that EVERY `git push` silently deleted your demo tenants — and the failure only
   * showed up much later as "Invalid tenant or credentials" on a login that used to work, with
   * nothing connecting the two events.
   *
   * Setting the variable (rather than only using it for the wipe) is the important part: db.ts
   * reads EMBEDDED_PG_DIR too, so both must agree or the suite would wipe one directory and then
   * start Postgres in another. An explicit EMBEDDED_PG_DIR from the caller still wins.
   */
  if (process.env.DB_MODE === 'embedded') {
    // UNCONDITIONAL override — deliberately ignores EMBEDDED_PG_DIR/PORT.
    //
    // A `|| fallback` was tried first and was wrong: `.env` is loaded before this runs, so a
    // developer's EMBEDDED_PG_DIR (pointing at their dev database) was inherited by the suite,
    // which then wiped exactly the data it was supposed to leave alone. The suite must own its
    // database unconditionally; use E2E_PG_DIR / E2E_PG_PORT to point it somewhere else.
    process.env.EMBEDDED_PG_DIR = process.env.E2E_PG_DIR || path.join(os.tmpdir(), 'nexcrm-e2e-pgdata');
    process.env.EMBEDDED_PG_PORT = process.env.E2E_PG_PORT || '5434';
  }
  if (process.env.DB_MODE === 'embedded' && process.env.E2E_KEEP_DB !== '1') {
    const dataDir = process.env.EMBEDDED_PG_DIR!;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (e: any) {
      console.warn(`could not remove ${dataDir}: ${e?.message}. If the suite fails on duplicate tenants, delete it manually.`);
    }
  }

  await initDb();

  // seed minimal plan + host owner directly (avoid depending on seed.ts having run)
  await control(c => c.query(
    // High limits so the suite itself isn't throttled; the rate limiter is exercised
    // deliberately later via a per-tenant override.
    `INSERT INTO plans (code, name, max_users, api_daily_quota, api_rate_per_sec, features)
     VALUES ('pro','Pro',50,5000000,10000,'{}') ON CONFLICT (code) DO NOTHING`));
  const ownerHash = await bcrypt.hash('e2e-owner-pw', 10);
  await control(c => c.query(
    `INSERT INTO host_users (email, name, password_hash, role) VALUES ('e2e-owner@test.local','E2E Owner',$1,'owner')
     ON CONFLICT (email) DO NOTHING`, [ownerHash]));

  const { default: express } = await import('express');
  const { default: cors } = await import('cors');
  const { authRouter, hostAuthRouter, requireAuth, requireHostAuth, enforcePasswordChange } = await import('../src/auth.js');
  const { leadsRouter } = await import('../src/routes/leads.js');
  const { activityTypesRouter } = await import('../src/routes/activityTypes.js');
  const { usersRouter, rolesRouter, permissionSetsRouter, apiKeysRouter, meRouter, brandingRouter } = await import('../src/routes/users.js');
  const { customFieldsRouter, stagesRouter } = await import('../src/routes/customFields.js');
  const { opportunitiesRouter, opportunityTypesRouter } = await import('../src/routes/opportunities.js');
  const { tasksRouter } = await import('../src/routes/tasks.js');
  const { distributionRouter } = await import('../src/routes/distribution.js');
  const { connectorsRouter, publicCaptureRouter } = await import('../src/routes/connectors.js');
  const { reportsRouter } = await import('../src/routes/reports.js');
  const { activitiesRouter } = await import('../src/routes/activities.js');
  const { filesRouter } = await import('../src/routes/files.js');
  const { formsRouter } = await import('../src/routes/forms.js');
  const { docsRouter } = await import('../src/routes/docs.js');
  const { webhooksRouter } = await import('../src/routes/webhooksAdmin.js');
  const { hostAdminRouter } = await import('../src/routes/hostAdmin.js');
  const { smartViewsRouter } = await import('../src/routes/smartViews.js');
  const { auditRouter } = await import('../src/routes/audit.js');
  const { rateLimit } = await import('../src/rateLimit.js');
  const { importsRouter } = await import('../src/routes/imports.js');
  const { tenantSettingsRouter } = await import('../src/routes/tenantSettings.js');
  const { automationRouter } = await import('../src/routes/automation.js');
  const { customActionsRouter } = await import('../src/routes/customActions.js');
  const { captureRouter } = await import('../src/routes/capture.js');
  const { featuresRouter } = await import('../src/routes/features.js');
  const { isBlockedIp, safeHttpCall } = await import('../src/http.js');
  const { mergeString, mergeJsonBody } = await import('../src/merge.js');
  const { telephonyRouter, eventsRouter } = await import('../src/routes/telephony.js');
  const { messagingRouter } = await import('../src/routes/messaging.js');
  const { widgetsRouter, sanitizeHtml } = await import('../src/routes/widgets.js');
  const { bulkRouter } = await import('../src/routes/bulk.js');
  const { encryptSecrets, decryptSecrets, maskSecret } = await import('../src/crypto.js');
  const { tenantRateLimit, consumeQuota, invalidateLimits } = await import('../src/quota.js');
  const { runScheduledDistribution } = await import('../src/scheduler.js');
  const { paymentsRouter, paymentWebhookRouter } = await import('../src/routes/payments.js');
  const { uiVariantsRouter, uiVariantPublicRouter } = await import('../src/routes/uiVariants.js');
  const { apiRequestLogger, redact } = await import('../src/apiLog.js');
  const { purgeTenant, resolveRetention, runRetentionSweep } = await import('../src/retention.js');
  const { hostTeamRouter } = await import('../src/routes/hostTeam.js');
  const { ledgerRouter } = await import('../src/routes/ledger.js');
  const { dataExportRouter } = await import('../src/routes/dataExport.js');
  const { ipInCidr, hostCan } = await import('../src/auth.js');
  const { generateDemoData } = await import('../src/demoData.js');
  const { startWebhookDispatcher, stopWebhookDispatcher } = await import('../src/webhooks.js');

  const { requestLogger } = await import('../src/logger.js');

  const app = express();
  app.use(cors());
  app.use(requestLogger());
  // Same SEO hygiene as production: nothing this API serves should be indexable.
  app.use((_r: any, res: any, next: any) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    next();
  });
  app.get('/robots.txt', (_r: any, res: any) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  // Payment webhooks need the raw body for signature verification.
  app.use('/payments/webhook', express.json({
    verify: (r: any, _res: any, buf: Buffer) => { r.rawBody = buf.toString('utf8'); },
  }));
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/host/auth', hostAuthRouter);
  app.use('/host/api', requireHostAuth, hostAdminRouter);
  const v1 = express.Router();
  v1.use(requireAuth);
  v1.use(enforcePasswordChange);
  v1.use(tenantRateLimit());
  v1.use(apiRequestLogger());
  v1.use('/leads', leadsRouter);
  v1.use('/activity-types', activityTypesRouter);
  v1.use('/users', usersRouter);
  v1.use('/roles', rolesRouter);
  v1.use('/permission-sets', permissionSetsRouter);
  v1.use('/api-keys', apiKeysRouter);
  v1.use('/fields', customFieldsRouter);
  v1.use('/stages', stagesRouter);
  v1.use('/opportunities', opportunitiesRouter);
  v1.use('/opportunity-types', opportunityTypesRouter);
  v1.use('/tasks', tasksRouter);
  v1.use('/me', meRouter);
  v1.use('/branding', brandingRouter);
  v1.use('/distribution-rules', distributionRouter);
  v1.use('/webhooks', webhooksRouter);
  v1.use('/connectors', connectorsRouter);
  v1.use('/reports', reportsRouter);
  v1.use('/activities', activitiesRouter);
  v1.use('/files', filesRouter);
  v1.use('/forms', formsRouter);
  v1.use('/smart-views', smartViewsRouter);
  v1.use('/audit', auditRouter);
  v1.use('/imports', importsRouter);
  v1.use('/settings/tenant', tenantSettingsRouter);
  v1.use('/automation', automationRouter);
  v1.use('/custom-actions', customActionsRouter);
  v1.use('/capture', captureRouter);
  v1.use('/features', featuresRouter);
  v1.use('/telephony', telephonyRouter);
  v1.use('/events', eventsRouter);
  v1.use('/messaging', messagingRouter);
  v1.use('/widgets', widgetsRouter);
  v1.use('/bulk', bulkRouter);
  v1.use('/payments', paymentsRouter);
  v1.use('/ui-variant', uiVariantPublicRouter);
  app.use('/payments', paymentWebhookRouter);
  app.use('/host/api/ui-variants', requireHostAuth, uiVariantsRouter);
  app.use('/host/api/team', requireHostAuth, hostTeamRouter);
  app.use('/host/api/ledger', requireHostAuth, ledgerRouter);
  v1.use('/export', dataExportRouter);
  // dedicated rate-limited login mount to verify 429 behaviour
  app.use('/rl/auth', rateLimit({ windowMs: 60_000, max: 3, keyPrefix: 'e2e-login' }), authRouter);
  app.use('/capture/v1', publicCaptureRouter);
  app.use('/docs', docsRouter);
  v1.get('/me', async (r: any, res: any) => {
    const { control } = await import('../src/db.js');
    const row = (await control(c => c.query(`SELECT ui_version FROM tenants WHERE id=$1`, [r.auth.tenantId]))).rows[0];
    res.json({
      permissions: r.auth.perms, recordScope: r.auth.recordScope,
      mustChangePassword: r.auth.mustChangePassword, uiVersion: row?.ui_version ?? 1,
    });
  });
  app.use('/v1', v1);

  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  startWebhookDispatcher(500);

  // small webhook receiver to verify delivery
  let received: any[] = [];
  const receiver = http.createServer((r, res) => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => { received.push(JSON.parse(data || '{}')); res.writeHead(200); res.end('ok'); });
  });
  await new Promise<void>(resolve => receiver.listen(0, resolve));
  const receiverPort = (receiver.address() as any).port;

  try {
    // ---- host login ----
    const hostLogin = await req(base, 'POST', '/host/auth/login', { email: 'e2e-owner@test.local', password: 'e2e-owner-pw' });
    assert('host admin login', hostLogin.status === 200 && hostLogin.json.token, JSON.stringify(hostLogin.json));
    const hostToken = hostLogin.json.token;
    const hostAuth = { authorization: `Bearer ${hostToken}` };

    // ---- create tenant A via API (exercises hostAdmin route + provisioning) ----
    const tenantAResp = await req(base, 'POST', '/host/api/tenants', {
      name: 'Acme Corp', subdomain: 'acme-e2e', isTest: true, planCode: 'pro',
      adminEmail: 'admin@acme.local', adminPassword: 'AdminPw123!',
    }, hostAuth);
    assert('create tenant A', tenantAResp.status === 201, JSON.stringify(tenantAResp.json));
    const tenantACode = tenantAResp.json.code;

    // ---- create tenant B (for isolation test) ----
    const tenantBResp = await req(base, 'POST', '/host/api/tenants', {
      name: 'Beta Inc', subdomain: 'beta-e2e', isTest: true, planCode: 'pro',
      adminEmail: 'admin@beta.local', adminPassword: 'AdminPw123!',
    }, hostAuth);
    assert('create tenant B', tenantBResp.status === 201, JSON.stringify(tenantBResp.json));

    // ---- tenant A admin login ----
    const loginA = await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'admin@acme.local', password: 'AdminPw123!' });
    assert('tenant A admin login', loginA.status === 200 && loginA.json.token, JSON.stringify(loginA.json));
    const adminAuthA = { authorization: `Bearer ${loginA.json.token}` };

    // ---- tenant B admin login ----
    const loginB = await req(base, 'POST', '/auth/login', { tenantCode: tenantBResp.json.code, email: 'admin@beta.local', password: 'AdminPw123!' });
    const adminAuthB = { authorization: `Bearer ${loginB.json.token}` };

    // ---- create custom field on tenant A ----
    const fieldResp = await req(base, 'POST', '/v1/fields/lead', { label: 'City Tier', type: 'dropdown', options: ['Tier1', 'Tier2', 'Tier3'] }, adminAuthA);
    assert('create custom field mx_city_tier', fieldResp.status === 201 && fieldResp.json.schema_name === 'mx_city_tier', JSON.stringify(fieldResp.json));

    // ---- create a sales user under tenant A ----
    const rolesA = await req(base, 'GET', '/v1/roles', undefined, adminAuthA);
    const salesRole = rolesA.json.items.find((r: any) => r.name === 'Sales User');
    const salesUserResp = await req(base, 'POST', '/v1/users', {
      email: 'sales1@acme.local', firstName: 'Sales', lastName: 'One', password: 'SalesPw123!', roleId: salesRole.id,
    }, adminAuthA);
    assert('create sales user', salesUserResp.status === 201, JSON.stringify(salesUserResp.json));
    const salesUserId = salesUserResp.json.id;

    const salesLogin = await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'sales1@acme.local', password: 'SalesPw123!' });
    const salesAuth = { authorization: `Bearer ${salesLogin.json.token}` };

    // ---- distribution rule: round robin to the sales user ----
    const ruleResp = await req(base, 'POST', '/v1/distribution-rules', {
      name: 'RR to Sales1', priority: 10, conditions: [], strategy: 'round_robin', strategyConfig: { userIds: [salesUserId] },
    }, adminAuthA);
    assert('create distribution rule', ruleResp.status === 201, JSON.stringify(ruleResp.json));

    // ---- webhook subscription pointing at local receiver ----
    const whResp = await req(base, 'POST', '/v1/webhooks', {
      url: `http://127.0.0.1:${receiverPort}/hook`, events: ['lead.created'],
    }, adminAuthA);
    assert('create webhook subscription', whResp.status === 201, JSON.stringify(whResp.json));

    // ---- capture a lead (as admin, unauthenticated capture would go through connector token; here via API) ----
    const captureResp = await req(base, 'POST', '/v1/leads/capture', {
      firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+919876543210',
      source: 'Website', fields: { mx_city_tier: 'Tier1' }, consent: true,
    }, adminAuthA);
    assert('capture lead', captureResp.status === 201 && captureResp.json.lead, JSON.stringify(captureResp.json));
    const leadId = captureResp.json.lead.id;

    // ---- verify auto-distribution assigned to sales user ----
    const leadGet = await req(base, 'GET', `/v1/leads/${leadId}`, undefined, adminAuthA);
    assert('lead auto-distributed to sales user', leadGet.json.owner_id === salesUserId, `owner=${leadGet.json.owner_id} expected=${salesUserId}`);

    // ---- verify sales user CAN view own lead ----
    const salesView = await req(base, 'GET', `/v1/leads/${leadId}`, undefined, salesAuth);
    assert('sales user can view own lead', salesView.status === 200);

    // ---- verify sales user CANNOT delete lead (permission denied) ----
    const salesDelete = await req(base, 'DELETE', `/v1/leads/${leadId}`, undefined, salesAuth);
    assert('sales user forbidden from deleting lead', salesDelete.status === 403, JSON.stringify(salesDelete.json));

    // ---- post a custom activity ----
    const actTypeResp = await req(base, 'POST', '/v1/activity-types', {
      name: 'Site Visit', direction: 0, score: 10, fields: [{ label: 'Property', type: 'text', mandatory: true }],
    }, adminAuthA);
    assert('create custom activity type', actTypeResp.status === 201, JSON.stringify(actTypeResp.json));

    const postAct = await req(base, 'POST', `/v1/leads/${leadId}/activities`, {
      typeName: 'Site Visit', note: 'Visited model flat', fields: { mx_property: 'Skyline Towers' },
    }, salesAuth);
    assert('post custom activity as sales user', postAct.status === 201, JSON.stringify(postAct.json));

    const leadAfterActivity = await req(base, 'GET', `/v1/leads/${leadId}`, undefined, adminAuthA);
    assert('lead score incremented by activity', leadAfterActivity.json.score === 10, `score=${leadAfterActivity.json.score}`);

    // ---- API key delete-scope enforcement ----
    const keyResp = await req(base, 'POST', '/v1/api-keys', { name: 'sales-key', scopes: ['leads:read', 'leads:write'] }, salesAuth);
    assert('sales user can create non-delete api key', keyResp.status === 201, JSON.stringify(keyResp.json));
    const keyDeleteAttempt = await req(base, 'POST', '/v1/api-keys', { name: 'sales-key-2', scopes: ['leads:delete'] }, salesAuth);
    assert('sales user forbidden from issuing delete-scoped key', keyDeleteAttempt.status === 403, JSON.stringify(keyDeleteAttempt.json));

    const apiKeyId = keyResp.json.key_id;
    const apiKeySecret = keyResp.json.secret;
    const viaApiKey = await req(base, 'GET', '/v1/leads', undefined, { 'x-api-key-id': apiKeyId, 'x-api-key-secret': apiKeySecret });
    assert('list leads via api key succeeds (read scope)', viaApiKey.status === 200, JSON.stringify(viaApiKey.json));
    const deleteViaApiKey = await req(base, 'DELETE', `/v1/leads/${leadId}`, undefined, { 'x-api-key-id': apiKeyId, 'x-api-key-secret': apiKeySecret });
    assert('delete via api key without delete scope rejected', deleteViaApiKey.status === 403, JSON.stringify(deleteViaApiKey.json));

    // ---- cross-tenant isolation: tenant B admin must NOT see tenant A's lead ----
    const crossTenantGet = await req(base, 'GET', `/v1/leads/${leadId}`, undefined, adminAuthB);
    assert('cross-tenant read blocked by RLS', crossTenantGet.status === 404, JSON.stringify(crossTenantGet.json));
    const crossTenantList = await req(base, 'GET', '/v1/leads', undefined, adminAuthB);
    assert('tenant B lead list does not include tenant A lead', crossTenantList.status === 200 && !crossTenantList.json.items.find((l: any) => l.id === leadId));

    // ---- NEW: unique custom field enforcement ----
    const uniqueField = await req(base, 'POST', '/v1/fields/lead', { label: 'Aadhaar No', type: 'text', unique: true }, adminAuthA);
    assert('create unique custom field', uniqueField.status === 201 && uniqueField.json.is_unique === true, JSON.stringify(uniqueField.json));
    const leadU1 = await req(base, 'POST', '/v1/leads', { firstName: 'Uniq1', email: 'u1@x.com', fields: { mx_aadhaar_no: '1234' } }, adminAuthA);
    assert('lead with unique value created', leadU1.status === 201, JSON.stringify(leadU1.json));
    const leadU2 = await req(base, 'POST', '/v1/leads', { firstName: 'Uniq2', email: 'u2@x.com', fields: { mx_aadhaar_no: '1234' } }, adminAuthA);
    assert('duplicate unique value rejected (409)', leadU2.status === 409 && leadU2.json.error?.code === 'UNIQUE_FIELD_VIOLATION', JSON.stringify(leadU2.json));

    // ---- NEW: advanced filters on custom fields ----
    const filtered = await req(base, 'GET', `/v1/leads?filters=${encodeURIComponent(JSON.stringify([{ field: 'fields.mx_city_tier', op: 'eq', value: 'Tier1' }]))}`, undefined, adminAuthA);
    assert('advanced filter on custom field returns match', filtered.status === 200 && filtered.json.items.some((l: any) => l.id === leadId), JSON.stringify({ status: filtered.status, total: filtered.json?.total }));
    const filteredNone = await req(base, 'GET', `/v1/leads?filters=${encodeURIComponent(JSON.stringify([{ field: 'fields.mx_city_tier', op: 'eq', value: 'Tier3' }]))}`, undefined, adminAuthA);
    assert('advanced filter excludes non-matches', filteredNone.status === 200 && !filteredNone.json.items.some((l: any) => l.id === leadId));

    // ---- NEW: opportunity type with custom fields + opportunity on lead ----
    const oppType = await req(base, 'POST', '/v1/opportunity-types', { name: 'Online Course' }, adminAuthA);
    assert('create opportunity type', oppType.status === 201, JSON.stringify(oppType.json));
    const oppField = await req(base, 'POST', `/v1/opportunity-types/${oppType.json.id}/fields`, { label: 'Course Name', type: 'text', mandatory: false }, adminAuthA);
    assert('create opportunity-type field', oppField.status === 201 && oppField.json.schema_name === 'mx_course_name', JSON.stringify(oppField.json));
    const opp = await req(base, 'POST', '/v1/opportunities', {
      leadId, opportunityTypeId: oppType.json.id, name: 'Ravi - Online', amount: 50000, fields: { mx_course_name: 'JEE 2027' },
    }, adminAuthA);
    assert('create opportunity on lead with typed fields', opp.status === 201 && opp.json.fields?.mx_course_name === 'JEE 2027', JSON.stringify(opp.json));
    const oppStagePatch = await req(base, 'PATCH', `/v1/opportunities/${opp.json.id}`, { stage: 'Closed Won' }, adminAuthA);
    assert('opportunity stage change flips status to Won', oppStagePatch.status === 200 && oppStagePatch.json.status === 'Won', JSON.stringify(oppStagePatch.json));

    // ---- NEW: user custom fields + change password + branding ----
    const userField = await req(base, 'POST', '/v1/fields/user', { label: 'Employee Code', type: 'text', unique: true }, adminAuthA);
    assert('create user custom field', userField.status === 201, JSON.stringify(userField.json));
    const salesPatch = await req(base, 'PATCH', `/v1/users/${salesUserId}`, { fields: { mx_employee_code: 'EMP-001' } }, adminAuthA);
    assert('set user custom field value', salesPatch.status === 200 && salesPatch.json.fields?.mx_employee_code === 'EMP-001', JSON.stringify(salesPatch.json));
    const pwChange = await req(base, 'POST', '/v1/me/change-password', { currentPassword: 'SalesPw123!', newPassword: 'SalesPw456!!' }, salesAuth);
    assert('change own password', pwChange.status === 204, JSON.stringify(pwChange.json));
    const reLogin = await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'sales1@acme.local', password: 'SalesPw456!!' });
    assert('login works with new password', reLogin.status === 200 && reLogin.json.token);
    const brandingPatch = await req(base, 'PATCH', '/v1/branding', { appName: 'Acme Sales', primaryColor: '#0a7d4f' }, adminAuthA);
    assert('tenant admin can set branding', brandingPatch.status === 200 && brandingPatch.json.branding?.appName === 'Acme Sales', JSON.stringify(brandingPatch.json));
    const brandingDenied = await req(base, 'PATCH', '/v1/branding', { appName: 'Hacked' }, salesAuth);
    assert('sales user cannot set branding', brandingDenied.status === 403, JSON.stringify(brandingDenied.json));

    // ---- NEW: vertical starter template provisioning ----
    const eduTenant = await req(base, 'POST', '/host/api/tenants', {
      name: 'Coaching Co', subdomain: 'edu-e2e', isTest: true, planCode: 'pro', template: 'education',
      adminEmail: 'admin@edu.local', adminPassword: 'AdminPw123!',
    }, hostAuth);
    assert('create tenant from education template', eduTenant.status === 201, JSON.stringify(eduTenant.json));
    const eduLogin = await req(base, 'POST', '/auth/login', { tenantCode: eduTenant.json.code, email: 'admin@edu.local', password: 'AdminPw123!' });
    const eduAuth = { authorization: `Bearer ${eduLogin.json.token}` };
    const eduStages = await req(base, 'GET', '/v1/stages', undefined, eduAuth);
    assert('education template seeded vertical stages', eduStages.json.items.some((s: any) => s.name === 'Enrolled') && eduStages.json.items.some((s: any) => s.name === 'Demo Scheduled'), JSON.stringify(eduStages.json.items?.map((s: any) => s.name)));
    const eduFields = await req(base, 'GET', '/v1/fields/lead', undefined, eduAuth);
    assert('education template seeded vertical lead fields', eduFields.json.items.some((f: any) => f.schema_name === 'mx_course_interest'), JSON.stringify(eduFields.json.items?.map((f: any) => f.schema_name)));

    // ---- NEW: hosted lead-capture form page ----
    const webform = await req(base, 'POST', '/v1/connectors', { type: 'webform', name: 'Landing Form', config: {} }, adminAuthA);
    assert('create webform connector', webform.status === 201 && webform.json.public_token, JSON.stringify(webform.json));
    const formPage = await fetch(`${base}/capture/v1/forms/${webform.json.public_token}/page`);
    const formHtml = await formPage.text();
    assert('hosted form page renders', formPage.status === 200 && formHtml.includes('<form') && formHtml.includes('Phone'), `status=${formPage.status}`);
    const formPost = await req(base, 'POST', `/capture/v1/forms/${webform.json.public_token}`, { firstName: 'FormLead', phone: '+919999988888' });
    assert('hosted form submission creates lead', formPost.status === 201 && formPost.json.leadId, JSON.stringify(formPost.json));

    // ---- NEW: reports overview ----
    const overview = await req(base, 'GET', '/v1/reports/overview?coldDays=2', undefined, adminAuthA);
    assert('reports overview returns aggregates', overview.status === 200 && Array.isArray(overview.json.byStage) && overview.json.totals.total >= 2, JSON.stringify({ total: overview.json?.totals, stages: overview.json?.byStage?.length }));
    assert('reports include needs-attention structure', Array.isArray(overview.json.cold) && Array.isArray(overview.json.overdueTasks));

    // ---- NEW: activities full CRUD + opportunity-linked ----
    const oppActivity = await req(base, 'POST', '/v1/activities', {
      opportunityId: opp.json.id, typeName: 'Site Visit', note: 'On-opportunity visit', fields: { mx_property: 'Tower B' },
    }, adminAuthA);
    assert('post activity on opportunity (lead auto-resolved)', oppActivity.status === 201 && oppActivity.json.opportunity_id === opp.json.id && oppActivity.json.lead_id === leadId, JSON.stringify(oppActivity.json));
    const oppActList = await req(base, 'GET', `/v1/activities?opportunityId=${opp.json.id}`, undefined, adminAuthA);
    assert('list activities by opportunity', oppActList.status === 200 && oppActList.json.items.some((a: any) => a.id === oppActivity.json.id));
    const actPatch = await req(base, 'PATCH', `/v1/activities/${oppActivity.json.id}`, { note: 'Edited note', fields: { mx_property: 'Tower C' } }, adminAuthA);
    assert('edit activity', actPatch.status === 200 && actPatch.json.note === 'Edited note' && actPatch.json.fields.mx_property === 'Tower C', JSON.stringify(actPatch.json));
    const leadBeforeDel = await req(base, 'GET', `/v1/leads/${leadId}`, undefined, adminAuthA);
    const actDel = await req(base, 'DELETE', `/v1/activities/${oppActivity.json.id}`, undefined, adminAuthA);
    assert('delete activity', actDel.status === 204);
    const leadAfterDel = await req(base, 'GET', `/v1/leads/${leadId}`, undefined, adminAuthA);
    assert('lead score reversed on activity delete', leadAfterDel.json.score === leadBeforeDel.json.score - 10, `before=${leadBeforeDel.json.score} after=${leadAfterDel.json.score}`);

    // ---- NEW: file upload + download (for file/audio custom fields) ----
    const fileUp = await req(base, 'POST', '/v1/files', { name: 'test.txt', mime: 'text/plain', dataBase64: Buffer.from('hello nexcrm').toString('base64') }, adminAuthA);
    assert('upload file', fileUp.status === 201 && fileUp.json.id, JSON.stringify(fileUp.json));
    const fileDown = await fetch(`${base}/v1/files/${fileUp.json.id}`, { headers: { authorization: adminAuthA.authorization } });
    assert('download file with correct content', fileDown.status === 200 && (await fileDown.text()) === 'hello nexcrm');
    const fileCross = await req(base, 'GET', `/v1/files/${fileUp.json.id}`, undefined, adminAuthB);
    assert('cross-tenant file access blocked', fileCross.status === 404);

    // ---- NEW: custom forms — build, rules, submit as activity ----
    const formCreate = await req(base, 'POST', '/v1/forms', {
      name: 'Visit Report', entity: 'lead',
      definition: {
        sections: [{ title: 'Visit', items: [
          { kind: 'subheading', text: 'Property Details' },
          { kind: 'field', source: 'activity', schemaName: 'mx_property', label: 'Property', required: true },
        ] }],
        valueRules: [],
      },
      onSubmit: { action: 'post_activity', activityTypeId: actTypeResp.json.id },
    }, adminAuthA);
    assert('create custom form', formCreate.status === 201, JSON.stringify(formCreate.json));
    const formMissingReq = await req(base, 'POST', `/v1/forms/${formCreate.json.id}/submit`, { leadId, values: {} }, adminAuthA);
    assert('form enforces required fields', formMissingReq.status === 400 && formMissingReq.json.error?.code === 'MANDATORY_FIELD_MISSING', JSON.stringify(formMissingReq.json));
    const formSubmit = await req(base, 'POST', `/v1/forms/${formCreate.json.id}/submit`, { leadId, values: { mx_property: 'Palm Grove', __note: 'via form' } }, adminAuthA);
    assert('form submit posts activity', formSubmit.status === 201 && formSubmit.json.activity?.fields?.mx_property === 'Palm Grove', JSON.stringify(formSubmit.json));

    // update-lead form with value rule
    const formLead = await req(base, 'POST', '/v1/forms', {
      name: 'Qualify Lead', entity: 'lead',
      definition: {
        sections: [{ title: 'Qualification', items: [
          { kind: 'field', source: 'lead', schemaName: 'mx_city_tier', label: 'City Tier' },
        ] }],
        valueRules: [{ if: { field: 'mx_city_tier', op: 'eq', value: 'Tier2' }, set: { field: 'mx_city_tier', value: 'Tier3' } }],
      },
      onSubmit: { action: 'update_lead' },
    }, adminAuthA);
    const formLeadSubmit = await req(base, 'POST', `/v1/forms/${formLead.json.id}/submit`, { leadId, values: { mx_city_tier: 'Tier2' } }, adminAuthA);
    assert('form value rule applied on submit', formLeadSubmit.status === 201 && formLeadSubmit.json.lead?.fields?.mx_city_tier === 'Tier3', JSON.stringify(formLeadSubmit.json.lead?.fields));

    // ---- NEW (batch 1): CSV export respects scope + filters ----
    const exportResp = await fetch(`${base}/v1/leads/export`, { headers: { authorization: adminAuthA.authorization } });
    const exportText = await exportResp.text();
    assert('CSV export returns csv', exportResp.status === 200 && (exportResp.headers.get('content-type') || '').includes('text/csv') && exportText.includes('Lead Number'), `status=${exportResp.status}`);
    assert('CSV export includes captured lead + custom field column', exportText.includes('City Tier') && exportText.includes('ravi@example.com'), exportText.split('\n')[0]);

    // ---- NEW: bulk update (reassign) + bulk delete with scope ----
    const bl1 = await req(base, 'POST', '/v1/leads', { firstName: 'Bulk1', email: 'bulk1@x.com' }, adminAuthA);
    const bl2 = await req(base, 'POST', '/v1/leads', { firstName: 'Bulk2', email: 'bulk2@x.com' }, adminAuthA);
    const bulkUpd = await req(base, 'POST', '/v1/leads/bulk-update', { ids: [bl1.json.lead.id, bl2.json.lead.id], patch: { ownerId: salesUserId } }, adminAuthA);
    assert('bulk update reassigns leads', bulkUpd.status === 200 && bulkUpd.json.updated === 2, JSON.stringify(bulkUpd.json));
    const bulkUpdCheck = await req(base, 'GET', `/v1/leads/${bl1.json.lead.id}`, undefined, adminAuthA);
    assert('bulk update persisted owner', bulkUpdCheck.json.owner_id === salesUserId);
    const salesBulkDelete = await req(base, 'POST', '/v1/leads/bulk-delete', { ids: [bl1.json.lead.id] }, salesAuth);
    assert('sales user forbidden from bulk delete (no delete perm)', salesBulkDelete.status === 403, JSON.stringify(salesBulkDelete.json));
    const bulkDel = await req(base, 'POST', '/v1/leads/bulk-delete', { ids: [bl1.json.lead.id, bl2.json.lead.id] }, adminAuthA);
    assert('admin bulk delete soft-deletes leads', bulkDel.status === 200 && bulkDel.json.deleted === 2, JSON.stringify(bulkDel.json));
    const bulkDelCheck = await req(base, 'GET', `/v1/leads/${bl1.json.lead.id}`, undefined, adminAuthA);
    assert('bulk-deleted lead no longer retrievable', bulkDelCheck.status === 404);

    // ---- NEW: smart views (create, list, shared vs own, cross-tenant isolation) ----
    const svCreate = await req(base, 'POST', '/v1/smart-views', {
      entity: 'lead', name: 'Tier1 Leads', filters: [{ field: 'fields.mx_city_tier', op: 'eq', value: 'Tier1' }], columns: ['name', 'email'], isShared: true,
    }, adminAuthA);
    assert('create shared smart view (admin)', svCreate.status === 201 && svCreate.json.is_shared === true, JSON.stringify(svCreate.json));
    const svList = await req(base, 'GET', '/v1/smart-views?entity=lead', undefined, adminAuthA);
    assert('list smart views includes created', svList.status === 200 && svList.json.items.some((v: any) => v.id === svCreate.json.id));
    const svSalesSees = await req(base, 'GET', '/v1/smart-views?entity=lead', undefined, salesAuth);
    assert('shared smart view visible to other user', svSalesSees.json.items.some((v: any) => v.id === svCreate.json.id));
    const svSalesOwn = await req(base, 'POST', '/v1/smart-views', { entity: 'lead', name: 'My Private', filters: [], columns: ['name'], isShared: true }, salesAuth);
    assert('non-admin cannot force shared view', svSalesOwn.status === 201 && svSalesOwn.json.is_shared === false, JSON.stringify(svSalesOwn.json));
    const svAdminSeesPrivate = await req(base, 'GET', '/v1/smart-views?entity=lead', undefined, adminAuthA);
    assert('other user private view hidden from admin list', !svAdminSeesPrivate.json.items.some((v: any) => v.id === svSalesOwn.json.id));
    const svCross = await req(base, 'GET', '/v1/smart-views?entity=lead', undefined, adminAuthB);
    assert('smart views isolated per tenant', !svCross.json.items.some((v: any) => v.id === svCreate.json.id));

    // ---- NEW: audit log read endpoint ----
    const auditList = await req(base, 'GET', '/v1/audit?entity=lead', undefined, adminAuthA);
    assert('audit log lists lead events', auditList.status === 200 && auditList.json.total > 0 && auditList.json.items.some((a: any) => a.action.startsWith('lead.')), JSON.stringify({ total: auditList.json?.total }));
    const auditOne = await req(base, 'GET', `/v1/audit/${auditList.json.items[0].id}`, undefined, adminAuthA);
    assert('audit entry detail returns before/after', auditOne.status === 200 && 'before' in auditOne.json && 'after' in auditOne.json);
    const auditDenied = await req(base, 'GET', '/v1/audit', undefined, salesAuth);
    assert('sales user forbidden from audit log', auditDenied.status === 403, JSON.stringify(auditDenied.json));

    // ---- NEW: rate limiting returns 429 after threshold ----
    let rlStatuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await req(base, 'POST', '/rl/auth/login', { tenantCode: 'nope', email: 'x@x.com', password: 'bad' });
      rlStatuses.push(r.status);
    }
    assert('rate limiter eventually returns 429', rlStatuses.includes(429), JSON.stringify(rlStatuses));

    // ---- NEW (batch 2): auto-generated tenant admin credentials + forced password change ----
    const genTenant = await req(base, 'POST', '/host/api/tenants', {
      name: 'Generated Co', subdomain: 'gen-e2e', isTest: true, planCode: 'pro',
      adminEmail: 'admin@gen.local', // no adminPassword -> auto-generate
    }, hostAuth);
    assert('tenant created without adminPassword auto-generates credentials', genTenant.status === 201 && genTenant.json.generatedCredentials?.tempPassword && genTenant.json.generatedCredentials?.resetUrl, JSON.stringify(genTenant.json));
    const genTempPw = genTenant.json.generatedCredentials.tempPassword;
    const genResetUrl: string = genTenant.json.generatedCredentials.resetUrl;

    const genLogin1 = await req(base, 'POST', '/auth/login', { tenantCode: genTenant.json.code, email: 'admin@gen.local', password: genTempPw });
    assert('login with auto-generated temp password succeeds', genLogin1.status === 200 && genLogin1.json.mustChangePassword === true, JSON.stringify(genLogin1.json));
    const genAuth1 = { authorization: `Bearer ${genLogin1.json.token}` };
    const genBlockedLeads = await req(base, 'GET', '/v1/leads', undefined, genAuth1);
    assert('forced password change blocks other endpoints', genBlockedLeads.status === 403 && genBlockedLeads.json.error?.code === 'PASSWORD_CHANGE_REQUIRED', JSON.stringify(genBlockedLeads.json));
    const genMeAllowed = await req(base, 'GET', '/v1/me/profile', undefined, genAuth1);
    assert('forced password change still allows /me endpoints', genMeAllowed.status === 200, JSON.stringify(genMeAllowed.json));
    const genChangePw = await req(base, 'POST', '/v1/me/change-password', { currentPassword: genTempPw, newPassword: 'GenNewPw123!' }, genAuth1);
    assert('change-password clears the forced flag', genChangePw.status === 204, JSON.stringify(genChangePw.json));
    const genLoginAfter = await req(base, 'POST', '/auth/login', { tenantCode: genTenant.json.code, email: 'admin@gen.local', password: 'GenNewPw123!' });
    assert('re-login after password change is unrestricted', genLoginAfter.status === 200 && genLoginAfter.json.mustChangePassword === false, JSON.stringify(genLoginAfter.json));
    const genAuth2 = { authorization: `Bearer ${genLoginAfter.json.token}` };
    const genLeadsNow = await req(base, 'GET', '/v1/leads', undefined, genAuth2);
    assert('non-restricted session can hit normal endpoints', genLeadsNow.status === 200, JSON.stringify(genLeadsNow.json));

    // ---- NEW: admin-generated set-password link (alternative to temp password) ----
    const resetToken = new URL(genResetUrl).searchParams.get('token')!;
    const badReset = await req(base, 'POST', '/auth/reset-password', { token: 'not-a-real-token', newPassword: 'WontWork123!' });
    assert('invalid reset token rejected', badReset.status === 400, JSON.stringify(badReset.json));
    // (the tempPassword flow already consumed must_change_password above; issue a fresh link to prove the link path works end-to-end)
    const freshLink = await req(base, 'POST', `/v1/users/${salesUserId}/reset-link`, undefined, adminAuthA);
    assert('admin can generate a set-password link for an existing user', freshLink.status === 201 && freshLink.json.resetUrl, JSON.stringify(freshLink.json));
    const freshToken = new URL(freshLink.json.resetUrl).searchParams.get('token')!;
    const consumeLink = await req(base, 'POST', '/auth/reset-password', { token: freshToken, newPassword: 'SalesPwViaLink1!' });
    assert('consuming a set-password link succeeds', consumeLink.status === 204, JSON.stringify(consumeLink.json));
    const reusedLink = await req(base, 'POST', '/auth/reset-password', { token: freshToken, newPassword: 'AnotherPw123!' });
    assert('a used set-password link cannot be reused', reusedLink.status === 400, JSON.stringify(reusedLink.json));
    const salesLoginViaLink = await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'sales1@acme.local', password: 'SalesPwViaLink1!' });
    assert('login works with password set via link', salesLoginViaLink.status === 200, JSON.stringify(salesLoginViaLink.json));

    // ---- NEW: user creation without a password auto-generates credentials ----
    const noPwUser = await req(base, 'POST', '/v1/users', { email: 'nopw@acme.local', firstName: 'NoPw', roleId: salesRole.id }, adminAuthA);
    assert('creating a user without password auto-generates one', noPwUser.status === 201 && noPwUser.json.generatedCredentials?.tempPassword, JSON.stringify(noPwUser.json));

    // ---- NEW: bulk user creation (mixed success/failure) ----
    const bulkUsers = await req(base, 'POST', '/v1/users/bulk', {
      users: [
        { email: 'bulk-a@acme.local', firstName: 'Bulk', lastName: 'A', roleId: salesRole.id },
        { email: 'sales1@acme.local', firstName: 'Dup', roleId: salesRole.id }, // duplicate email -> should fail
      ],
    }, adminAuthA);
    assert('bulk user create returns per-row results', bulkUsers.status === 201 && bulkUsers.json.created === 1 && bulkUsers.json.failed === 1, JSON.stringify(bulkUsers.json));
    assert('bulk user create reports duplicate email error', bulkUsers.json.results.some((r: any) => r.status === 'error' && r.code === 'EMAIL_EXISTS'), JSON.stringify(bulkUsers.json.results));

    // ---- NEW: TOTP 2FA enrollment + login flow ----
    const setup2fa = await req(base, 'POST', '/v1/me/2fa/setup', undefined, adminAuthA);
    assert('2fa setup returns a secret + otpauth url', setup2fa.status === 200 && setup2fa.json.secret && setup2fa.json.otpauthUrl?.startsWith('otpauth://'), JSON.stringify(setup2fa.json));
    const badVerify = await req(base, 'POST', '/v1/me/2fa/verify', { code: '000000' }, adminAuthA);
    assert('2fa verify rejects a wrong code', badVerify.status === 400, JSON.stringify(badVerify.json));
    const goodCode = totpNow(setup2fa.json.secret);
    const verify2fa = await req(base, 'POST', '/v1/me/2fa/verify', { code: goodCode }, adminAuthA);
    assert('2fa verify enables 2FA and returns backup codes', verify2fa.status === 200 && verify2fa.json.enabled === true && verify2fa.json.backupCodes?.length === 8, JSON.stringify(verify2fa.json));
    const backupCode = verify2fa.json.backupCodes[0];

    const loginNeeds2fa = await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'admin@acme.local', password: 'AdminPw123!' });
    assert('login with 2fa enabled returns a pending token instead of a session', loginNeeds2fa.status === 200 && loginNeeds2fa.json.requires2fa === true && loginNeeds2fa.json.pendingToken, JSON.stringify(loginNeeds2fa.json));
    const wrong2faLogin = await req(base, 'POST', '/auth/login/2fa', { pendingToken: loginNeeds2fa.json.pendingToken, code: '111111' });
    assert('wrong 2fa code at login rejected', wrong2faLogin.status === 401, JSON.stringify(wrong2faLogin.json));
    const right2faLogin = await req(base, 'POST', '/auth/login/2fa', { pendingToken: loginNeeds2fa.json.pendingToken, code: totpNow(setup2fa.json.secret) });
    assert('correct 2fa code completes login', right2faLogin.status === 200 && right2faLogin.json.token, JSON.stringify(right2faLogin.json));

    const loginNeeds2faAgain = await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'admin@acme.local', password: 'AdminPw123!' });
    const backupLogin = await req(base, 'POST', '/auth/login/2fa', { pendingToken: loginNeeds2faAgain.json.pendingToken, code: backupCode });
    assert('backup code completes login', backupLogin.status === 200 && backupLogin.json.token, JSON.stringify(backupLogin.json));
    const reuseBackup = await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'admin@acme.local', password: 'AdminPw123!' });
    const reuseBackupLogin = await req(base, 'POST', '/auth/login/2fa', { pendingToken: reuseBackup.json.pendingToken, code: backupCode });
    assert('a used backup code cannot be reused', reuseBackupLogin.status === 401, JSON.stringify(reuseBackupLogin.json));

    const disable2faWrongPw = await req(base, 'POST', '/v1/me/2fa/disable', { currentPassword: 'wrong' }, { authorization: `Bearer ${right2faLogin.json.token}` });
    assert('disabling 2fa requires correct current password', disable2faWrongPw.status === 401, JSON.stringify(disable2faWrongPw.json));
    const disable2fa = await req(base, 'POST', '/v1/me/2fa/disable', { currentPassword: 'AdminPw123!' }, { authorization: `Bearer ${right2faLogin.json.token}` });
    assert('2fa can be disabled', disable2fa.status === 204, JSON.stringify(disable2fa.json));
    const loginNo2faNow = await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'admin@acme.local', password: 'AdminPw123!' });
    assert('login no longer requires 2fa after disabling', loginNo2faNow.status === 200 && !loginNo2faNow.json.requires2fa && loginNo2faNow.json.token, JSON.stringify(loginNo2faNow.json));

    // ---- NEW: audit "History" timeline — scoped access without admin permission ----
    const salesAuthFresh = { authorization: `Bearer ${(await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'sales1@acme.local', password: 'SalesPwViaLink1!' })).json.token}` };
    const leadHistoryAsSales = await req(base, 'GET', `/v1/audit?leadId=${leadId}`, undefined, salesAuthFresh);
    assert('lead owner can view scoped history without admin permission', leadHistoryAsSales.status === 200 && leadHistoryAsSales.json.items.length > 0, JSON.stringify({ status: leadHistoryAsSales.status, total: leadHistoryAsSales.json?.total }));
    assert('scoped history includes the opportunity created on this lead', leadHistoryAsSales.json.items.some((a: any) => a.entity === 'opportunity'), JSON.stringify(leadHistoryAsSales.json.items.map((a: any) => a.entity)));
    const broadHistoryAsSales = await req(base, 'GET', '/v1/audit', undefined, salesAuthFresh);
    assert('unscoped audit browsing still requires manageRoles', broadHistoryAsSales.status === 403, JSON.stringify(broadHistoryAsSales.json));
    const historyDetail = await req(base, 'GET', `/v1/audit/${leadHistoryAsSales.json.items[0].id}?leadId=${leadId}`, undefined, salesAuthFresh);
    assert('scoped history detail returns before/after', historyDetail.status === 200 && ('before' in historyDetail.json), JSON.stringify(historyDetail.json));

    // ---- NEW: docs page ----
    const docs = await fetch(`${base}/docs`);
    assert('API docs page served', docs.status === 200 && (await docs.text()).includes('NexCRM API Documentation'));

    // ---- webhook delivery arrives at receiver within a few seconds ----
    let waited = 0;
    while (received.length === 0 && waited < 6000) { await new Promise(r => setTimeout(r, 300)); waited += 300; }
    assert('webhook delivered to subscriber', received.length > 0 && received[0]?.event === 'lead.created', JSON.stringify(received[0]));
    if (received.length) {
      assert('webhook payload references correct tenant', received[0].tenantId === tenantAResp.json.id);
    }

    // =========================================================================================
    // Batch 3: system user, hierarchy, default-owner fallback, cascades, telephony API,
    // system field protection, tenant settings CRUD. Uses tenant B, which is otherwise idle.
    // =========================================================================================
    const tenantBCode = tenantBResp.json.code;
    const meB = await req(base, 'GET', '/v1/me/profile', undefined, adminAuthB);
    const adminBId = meB.json.id;
    const usersB0 = await req(base, 'GET', '/v1/users', undefined, adminAuthB);
    const systemUserB = usersB0.json.items.find((u: any) => u.email === `${tenantBCode.toLowerCase()}@nextcrm.com`);
    assert('system user auto-provisioned for tenant', !!systemUserB, JSON.stringify(usersB0.json.items.map((u: any) => u.email)));
    assert('both admin and system user are flagged is_system', usersB0.json.items.find((u: any) => u.id === adminBId)?.is_system === true && systemUserB.is_system === true);

    // ---- System/Admin can never be deactivated ----
    const deactivateAdmin = await req(base, 'PATCH', `/v1/users/${adminBId}`, { isActive: false }, adminAuthB);
    assert('admin user cannot be deactivated', deactivateAdmin.status === 400 && deactivateAdmin.json.error?.code === 'CANNOT_DEACTIVATE_SYSTEM_USER', JSON.stringify(deactivateAdmin.json));
    const deactivateSystem = await req(base, 'PATCH', `/v1/users/${systemUserB.id}`, { isActive: false }, adminAuthB);
    assert('system user cannot be deactivated', deactivateSystem.status === 400 && deactivateSystem.json.error?.code === 'CANNOT_DEACTIVATE_SYSTEM_USER', JSON.stringify(deactivateSystem.json));

    // ---- tenant settings CRUD round trip ----
    const settingsGet0 = await req(base, 'GET', '/v1/settings/tenant', undefined, adminAuthB);
    assert('tenant settings returns defaults', settingsGet0.status === 200 && settingsGet0.json.defaultOwnerMode === 'system' && settingsGet0.json.hierarchyVisibility === true && settingsGet0.json.cascadeOwnerToOpportunity === true, JSON.stringify(settingsGet0.json));
    const badMode = await req(base, 'PATCH', '/v1/settings/tenant', { defaultOwnerMode: 'bogus' }, adminAuthB);
    assert('tenant settings rejects invalid defaultOwnerMode', badMode.status === 400, JSON.stringify(badMode.json));
    const badPhoneAction = await req(base, 'PATCH', '/v1/settings/tenant', { phoneClickAction: 'url_template' }, adminAuthB);
    assert('tenant settings requires template when phoneClickAction is url_template', badPhoneAction.status === 400, JSON.stringify(badPhoneAction.json));
    const goodPhoneAction = await req(base, 'PATCH', '/v1/settings/tenant', { phoneClickAction: 'url_template', phoneClickUrlTemplate: 'https://dialer.example.com/call?n={number}' }, adminAuthB);
    assert('tenant settings accepts phoneClickAction + template together', goodPhoneAction.status === 200 && goodPhoneAction.json.phoneClickUrlTemplate?.includes('{number}'), JSON.stringify(goodPhoneAction.json));
    await req(base, 'PATCH', '/v1/settings/tenant', { phoneClickAction: 'tel' }, adminAuthB); // reset for later tests

    // ---- roles for tenant B ----
    const rolesB = await req(base, 'GET', '/v1/roles', undefined, adminAuthB);
    const managerRoleB = rolesB.json.items.find((r: any) => r.name === 'Sales Manager');
    const salesRoleB = rolesB.json.items.find((r: any) => r.name === 'Sales User');

    // ---- manager hierarchy: manager1 -> rep1, rep2 has no manager ----
    const manager1 = await req(base, 'POST', '/v1/users', { email: 'manager1@beta.local', firstName: 'Manager', lastName: 'One', password: 'ManagerPw123!', roleId: managerRoleB.id }, adminAuthB);
    assert('create manager user', manager1.status === 201, JSON.stringify(manager1.json));
    const rep1 = await req(base, 'POST', '/v1/users', { email: 'rep1@beta.local', firstName: 'Rep', lastName: 'One', password: 'RepPw123!', roleId: salesRoleB.id, managerId: manager1.json.id }, adminAuthB);
    assert('create rep reporting to manager', rep1.status === 201 && rep1.json.manager_id === manager1.json.id, JSON.stringify(rep1.json));
    const rep2 = await req(base, 'POST', '/v1/users', { email: 'rep2@beta.local', firstName: 'Rep', lastName: 'Two', password: 'RepPw123!', roleId: salesRoleB.id }, adminAuthB);
    assert('create rep with no manager', rep2.status === 201 && !rep2.json.manager_id, JSON.stringify(rep2.json));
    const selfManagerAttempt = await req(base, 'PATCH', `/v1/users/${rep1.json.id}`, { managerId: rep1.json.id }, adminAuthB);
    assert('a user cannot be set as their own manager', selfManagerAttempt.status === 400, JSON.stringify(selfManagerAttempt.json));

    const managerLogin = await req(base, 'POST', '/auth/login', { tenantCode: tenantBCode, email: 'manager1@beta.local', password: 'ManagerPw123!' });
    const managerAuth = { authorization: `Bearer ${managerLogin.json.token}` };

    // ---- default-owner fallback: 'system' mode (default) ----
    const capSystem = await req(base, 'POST', '/v1/leads/capture', { firstName: 'Unassigned1', email: 'unassigned1@beta.local', consent: true }, adminAuthB);
    assert('default-owner (system mode) assigns the System user', capSystem.status === 201 && capSystem.json.lead.owner_id === systemUserB.id, `owner=${capSystem.json.lead?.owner_id} expected=${systemUserB.id}`);

    // ---- default-owner fallback: 'user' mode ----
    await req(base, 'PATCH', '/v1/settings/tenant', { defaultOwnerMode: 'user', defaultOwnerUserId: rep2.json.id }, adminAuthB);
    const capUser = await req(base, 'POST', '/v1/leads/capture', { firstName: 'Unassigned2', email: 'unassigned2@beta.local', consent: true }, adminAuthB);
    assert('default-owner (user mode) assigns the configured user', capUser.status === 201 && capUser.json.lead.owner_id === rep2.json.id, `owner=${capUser.json.lead?.owner_id} expected=${rep2.json.id}`);

    // ---- default-owner fallback: 'field' mode (matches sub_source) + falls back to System when no rule matches ----
    await req(base, 'PATCH', '/v1/settings/tenant', {
      defaultOwnerMode: 'field',
      defaultOwnerFieldRules: [{ conditions: [{ field: 'sub_source', op: 'eq', value: 'Referral' }], userId: rep1.json.id }],
    }, adminAuthB);
    const capFieldMatch = await req(base, 'POST', '/v1/leads/capture', { firstName: 'Referral1', email: 'referral1@beta.local', subSource: 'Referral', consent: true }, adminAuthB);
    assert('default-owner (field mode) assigns matching rule owner', capFieldMatch.status === 201 && capFieldMatch.json.lead.owner_id === rep1.json.id, `owner=${capFieldMatch.json.lead?.owner_id} expected=${rep1.json.id}`);
    const capFieldNoMatch = await req(base, 'POST', '/v1/leads/capture', { firstName: 'Organic1', email: 'organic1@beta.local', subSource: 'Organic', consent: true }, adminAuthB);
    assert('default-owner (field mode) falls back to System when no rule matches', capFieldNoMatch.status === 201 && capFieldNoMatch.json.lead.owner_id === systemUserB.id, `owner=${capFieldNoMatch.json.lead?.owner_id} expected=${systemUserB.id}`);
    await req(base, 'PATCH', '/v1/settings/tenant', { defaultOwnerMode: 'system' }, adminAuthB); // reset

    // ---- hierarchy visibility: manager sees rep1's (their report's) leads, not rep2's ----
    const leadR1 = await req(base, 'POST', '/v1/leads', { firstName: 'HierLead1', email: 'hier1@beta.local', ownerId: rep1.json.id }, adminAuthB);
    const leadR2 = await req(base, 'POST', '/v1/leads', { firstName: 'HierLead2', email: 'hier2@beta.local', ownerId: rep2.json.id }, adminAuthB);
    const mgrSeesR1 = await req(base, 'GET', `/v1/leads/${leadR1.json.lead.id}`, undefined, managerAuth);
    assert('manager sees a report\'s lead via hierarchy visibility', mgrSeesR1.status === 200, JSON.stringify(mgrSeesR1.json));
    const mgrSeesR2 = await req(base, 'GET', `/v1/leads/${leadR2.json.lead.id}`, undefined, managerAuth);
    assert('manager cannot see a non-report\'s lead', mgrSeesR2.status === 403, JSON.stringify(mgrSeesR2.json));

    // ---- turning hierarchyVisibility off makes 'team' behave like 'own' ----
    await req(base, 'PATCH', '/v1/settings/tenant', { hierarchyVisibility: false }, adminAuthB);
    const mgrSeesR1Off = await req(base, 'GET', `/v1/leads/${leadR1.json.lead.id}`, undefined, managerAuth);
    assert('with hierarchyVisibility off, manager no longer sees report\'s lead', mgrSeesR1Off.status === 403, JSON.stringify(mgrSeesR1Off.json));
    await req(base, 'PATCH', '/v1/settings/tenant', { hierarchyVisibility: true }, adminAuthB); // restore

    // ---- System user always sees everything regardless of hierarchy setting ----
    const systemLoginResetB = await req(base, 'POST', `/v1/users/${systemUserB.id}/reset-link`, undefined, adminAuthB);
    const sysToken = new URL(systemLoginResetB.json.resetUrl).searchParams.get('token')!;
    await req(base, 'POST', '/auth/reset-password', { token: sysToken, newPassword: 'SystemPw123!' });
    const systemLogin = await req(base, 'POST', '/auth/login', { tenantCode: tenantBCode, email: systemUserB.email, password: 'SystemPw123!' });
    const systemAuth = { authorization: `Bearer ${systemLogin.json.token}` };
    const sysSeesR2 = await req(base, 'GET', `/v1/leads/${leadR2.json.lead.id}`, undefined, systemAuth);
    assert('System user can see any lead regardless of hierarchy/ownership', sysSeesR2.status === 200, JSON.stringify(sysSeesR2.json));

    // ---- auto-logged Stage Changed / Owner Changed activities + cascade to opportunities/tasks ----
    const oppTypesB = await req(base, 'GET', '/v1/opportunity-types', undefined, adminAuthB);
    const oppR1 = await req(base, 'POST', '/v1/opportunities', { leadId: leadR1.json.lead.id, opportunityTypeId: oppTypesB.json.items[0].id, name: 'Hier Opp', ownerId: rep1.json.id }, adminAuthB);
    const taskR1 = await req(base, 'POST', '/v1/tasks', { leadId: leadR1.json.lead.id, name: 'Follow up', ownerId: rep1.json.id }, adminAuthB);

    const stagePatch = await req(base, 'PATCH', `/v1/leads/${leadR1.json.lead.id}`, { stage: 'Contacted' }, adminAuthB);
    assert('stage patch succeeds', stagePatch.status === 200 && stagePatch.json.stage_id, JSON.stringify(stagePatch.json));
    const ownerPatch = await req(base, 'PATCH', `/v1/leads/${leadR1.json.lead.id}`, { ownerId: rep2.json.id }, adminAuthB);
    assert('owner patch succeeds', ownerPatch.status === 200 && ownerPatch.json.owner_id === rep2.json.id, JSON.stringify(ownerPatch.json));

    const r1Activities = await req(base, 'GET', `/v1/leads/${leadR1.json.lead.id}/activities`, undefined, adminAuthB);
    assert('Stage Changed activity appears in Activity History', r1Activities.json.items.some((a: any) => a.type_name === 'Stage Changed'), JSON.stringify(r1Activities.json.items?.map((a: any) => a.type_name)));
    assert('Owner Changed activity appears in Activity History', r1Activities.json.items.some((a: any) => a.type_name === 'Owner Changed'), JSON.stringify(r1Activities.json.items?.map((a: any) => a.type_name)));

    const oppAfterCascade = await req(base, 'GET', `/v1/opportunities?leadId=${leadR1.json.lead.id}`, undefined, adminAuthB);
    assert('owner-change cascades to linked opportunity', oppAfterCascade.json.items.find((o: any) => o.id === oppR1.json.id)?.owner_id === rep2.json.id, JSON.stringify(oppAfterCascade.json.items));
    const taskAfterCascade = await req(base, 'GET', `/v1/tasks?leadId=${leadR1.json.lead.id}`, undefined, adminAuthB);
    assert('owner-change cascades to linked task', taskAfterCascade.json.items.find((t: any) => t.id === taskR1.json.id)?.owner_id === rep2.json.id, JSON.stringify(taskAfterCascade.json.items));

    // ---- cascade can be turned off ----
    await req(base, 'PATCH', '/v1/settings/tenant', { cascadeOwnerToOpportunity: false, cascadeOwnerToTask: false }, adminAuthB);
    await req(base, 'PATCH', `/v1/leads/${leadR1.json.lead.id}`, { ownerId: rep1.json.id }, adminAuthB);
    const oppAfterNoCascade = await req(base, 'GET', `/v1/opportunities?leadId=${leadR1.json.lead.id}`, undefined, adminAuthB);
    assert('owner-change cascade to opportunity can be disabled', oppAfterNoCascade.json.items.find((o: any) => o.id === oppR1.json.id)?.owner_id === rep2.json.id, JSON.stringify(oppAfterNoCascade.json.items));
    await req(base, 'PATCH', '/v1/settings/tenant', { cascadeOwnerToOpportunity: true, cascadeOwnerToTask: true }, adminAuthB); // restore

    // ---- telephony combined API: one call logs an activity AND patches the lead's stage ----
    const callTypeB = await req(base, 'POST', '/v1/activity-types', { name: 'Sales Call', direction: 1, score: 5, fields: [{ label: 'Duration Seconds', type: 'number' }] }, adminAuthB);
    const telephonyCall = await req(base, 'POST', '/v1/activities', {
      leadId: leadR1.json.lead.id, typeId: callTypeB.json.id, note: 'Outbound sales call',
      fields: { mx_duration_seconds: 180 }, leadPatch: { stage: 'Qualified' },
    }, adminAuthB);
    assert('telephony combined API creates activity + patches lead in one call', telephonyCall.status === 201 && telephonyCall.json.lead?.stage_id, JSON.stringify(telephonyCall.json));
    const leadAfterTelephony = await req(base, 'GET', `/v1/leads/${leadR1.json.lead.id}`, undefined, adminAuthB);
    const qualifiedStage = (await req(base, 'GET', '/v1/stages', undefined, adminAuthB)).json.items.find((s: any) => s.name === 'Qualified');
    assert('telephony leadPatch actually moved the stage', leadAfterTelephony.json.stage_id === qualifiedStage.id, JSON.stringify({ got: leadAfterTelephony.json.stage_id, expected: qualifiedStage.id }));

    // ---- system field-defs: rename/hide still works, delete is blocked; ordinary custom fields still delete fine ----
    const leadFieldsB = await req(base, 'GET', '/v1/fields/lead', undefined, adminAuthB);
    const phoneFieldDef = leadFieldsB.json.items.find((f: any) => f.schema_name === 'phone');
    assert('phone is seeded as a system, non-deletable field', phoneFieldDef?.is_system === true && phoneFieldDef?.is_deletable === false, JSON.stringify(phoneFieldDef));
    const renamePhone = await req(base, 'PATCH', '/v1/fields/lead/phone', { label: 'Contact Number' }, adminAuthB);
    assert('system field can still be renamed', renamePhone.status === 200 && renamePhone.json.label === 'Contact Number', JSON.stringify(renamePhone.json));
    const deletePhone = await req(base, 'DELETE', '/v1/fields/lead/phone', undefined, adminAuthB);
    assert('system field cannot be deleted', deletePhone.status === 400 && deletePhone.json.error?.code === 'CANNOT_DELETE_SYSTEM_FIELD', JSON.stringify(deletePhone.json));
    const customFieldB = await req(base, 'POST', '/v1/fields/lead', { label: 'Test Delete Field', type: 'text' }, adminAuthB);
    const deleteCustomB = await req(base, 'DELETE', `/v1/fields/lead/${customFieldB.json.schema_name}`, undefined, adminAuthB);
    assert('ordinary custom field can still be deleted', deleteCustomB.status === 204, JSON.stringify(deleteCustomB.json));

    // =========================================================================================
    // Batch 4: SSRF guard, mail merge, entitlements, field write policy (manual vs API),
    // custom actions, automation engine, API-sourced dropdowns, unified capture.
    // =========================================================================================

    // ---- SSRF guard (pure unit checks — the most security-critical component) ----
    const blockedIps = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'notanip'];
    const allowedIps = ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255'];
    assert('SSRF: private/reserved IPs are blocked', blockedIps.every(ip => isBlockedIp(ip)),
      blockedIps.filter(ip => !isBlockedIp(ip)).join(',') || 'all blocked');
    assert('SSRF: public IPs are allowed', allowedIps.every(ip => !isBlockedIp(ip)),
      allowedIps.filter(ip => isBlockedIp(ip)).join(',') || 'all allowed');

    let ssrfRejected = 0;
    for (const badUrl of ['http://example.com/', 'file:///etc/passwd', 'https://localhost/',
                          'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/']) {
      try { await safeHttpCall({ url: badUrl, timeoutMs: 2000 }); } catch { ssrfRejected++; }
    }
    assert('SSRF: unsafe URLs rejected before any connection', ssrfRejected === 6, `${ssrfRejected}/6 rejected`);

    // ---- Mail merge ----
    const mctx = { lead: { phone: '+9199', full_name: 'A "B" C', fields: { mx_city: 'Pune' } }, owner: { email: 'o@x.com' } };
    assert('merge: resolves tokens incl. custom fields',
      mergeString('{{lead.phone}}|{{lead.fields.mx_city}}|{{owner.email}}', mctx) === '+9199|Pune|o@x.com',
      mergeString('{{lead.phone}}|{{lead.fields.mx_city}}|{{owner.email}}', mctx));
    assert('merge: unknown tokens resolve to empty (never left raw)',
      mergeString('x{{lead.nope}}y', mctx) === 'xy', mergeString('x{{lead.nope}}y', mctx));
    const jsonMerged = mergeJsonBody('{"n":"{{lead.full_name}}"}', mctx);
    assert('merge: JSON bodies stay valid when data contains quotes',
      (() => { try { return JSON.parse(jsonMerged).n === 'A "B" C'; } catch { return false; } })(), jsonMerged);

    // ---- Entitlements: paid features locked by default, enforced server-side ----
    const featBefore = await req(base, 'GET', '/v1/features', undefined, adminAuthA);
    assert('features endpoint lists paid capabilities', featBefore.status === 200 && featBefore.json.items.some((f: any) => f.key === 'automation'), JSON.stringify(featBefore.json?.items?.map((f: any) => f.key)));
    assert('automation is locked by default', featBefore.json.enabled.automation === false, JSON.stringify(featBefore.json.enabled));
    const lockedRule = await req(base, 'POST', '/v1/automation', {
      name: 'Blocked', trigger: { entity: 'lead', event: 'created' }, actions: [{ type: 'create_task', name: 'x' }],
    }, adminAuthA);
    assert('locked feature is enforced server-side (402)', lockedRule.status === 402 && lockedRule.json.error?.code === 'FEATURE_NOT_ENABLED', JSON.stringify(lockedRule.json));
    const lockedAction = await req(base, 'POST', '/v1/custom-actions', { name: 'x', entity: 'lead', urlTemplate: 'https://x.com' }, adminAuthA);
    assert('locked custom actions enforced server-side (402)', lockedAction.status === 402, JSON.stringify(lockedAction.json));

    // Unlock from the host admin panel (the "paid connector unlock" path)
    const badFeature = await req(base, 'PUT', `/host/api/tenants/${tenantAResp.json.id}/entitlements/nope`, { isEnabled: true }, hostAuth);
    assert('unknown feature key rejected', badFeature.status === 400, JSON.stringify(badFeature.json));
    for (const f of ['automation', 'custom_actions', 'api_field_options']) {
      const unlock = await req(base, 'PUT', `/host/api/tenants/${tenantAResp.json.id}/entitlements/${f}`, { isEnabled: true, note: 'e2e' }, hostAuth);
      assert(`host admin can unlock ${f}`, unlock.status === 200 && unlock.json.is_enabled === true, JSON.stringify(unlock.json));
    }
    const featAfter = await req(base, 'GET', '/v1/features', undefined, adminAuthA);
    assert('unlock takes effect immediately (cache invalidated)', featAfter.json.enabled.automation === true, JSON.stringify(featAfter.json.enabled));
    const entList = await req(base, 'GET', `/host/api/tenants/${tenantAResp.json.id}/entitlements`, undefined, hostAuth);
    assert('host admin can read effective entitlements', entList.status === 200 && entList.json.effective.automation === true, JSON.stringify(entList.json?.effective));

    // ---- Channel-aware field write policy (manual vs API) ----
    await req(base, 'POST', '/v1/fields/lead', { label: 'Ext Ref', type: 'text' }, adminAuthA);
    await req(base, 'POST', '/v1/fields/lead', { label: 'Human Note', type: 'text' }, adminAuthA);
    const psPolicy = await req(base, 'POST', '/v1/permission-sets', {
      name: 'Channel Policy', permissions: {
        lead: {
          view: 'all', create: true, edit: 'all', delete: false,
          // mx_ext_ref: only an integration may write it. mx_human_note: only a human may.
          fieldRules: { readonlyManual: ['mx_ext_ref'], readonlyApi: ['mx_human_note'] },
        },
        activity: { view: 'all', create: true, edit: 'all', delete: false },
        opportunity: { view: 'all', create: true, edit: 'all', delete: false },
        task: { view: 'all', create: true, edit: 'all', delete: false },
        user: { view: false, create: false, edit: false, delete: false },
        settings: {}, reports: { view: false },
      },
    }, adminAuthA);
    assert('create permission set with channel field rules', psPolicy.status === 201, JSON.stringify(psPolicy.json));
    const policyUser = await req(base, 'POST', '/v1/users', {
      email: 'policy@acme.local', firstName: 'Policy', password: 'PolicyPw123!', roleId: salesRole.id,
    }, adminAuthA);
    await req(base, 'POST', '/v1/permission-sets/assign', { permissionSetId: psPolicy.json.id, userId: policyUser.json.id }, adminAuthA);
    const policyLogin = await req(base, 'POST', '/auth/login', { tenantCode: tenantACode, email: 'policy@acme.local', password: 'PolicyPw123!' });
    const policyAuth = { authorization: `Bearer ${policyLogin.json.token}` };
    const policyKey = await req(base, 'POST', '/v1/api-keys', { name: 'policy-key', scopes: ['leads:read', 'leads:write'] }, policyAuth);
    const policyApiAuth = { 'x-api-key-id': policyKey.json.key_id, 'x-api-key-secret': policyKey.json.secret };

    const polLead = await req(base, 'POST', '/v1/leads', { firstName: 'PolicyLead', email: 'policylead@x.com' }, adminAuthA);
    const polLeadId = polLead.json.lead.id;

    const manualWrite = await req(base, 'PATCH', `/v1/leads/${polLeadId}`,
      { fields: { mx_ext_ref: 'FROM-UI', mx_human_note: 'ui-ok' } }, policyAuth);
    assert('manual channel: readonlyManual field is dropped', manualWrite.status === 200 && manualWrite.json._blockedFields?.includes('mx_ext_ref'), JSON.stringify(manualWrite.json?._blockedFields));
    const afterManual = await req(base, 'GET', `/v1/leads/${polLeadId}`, undefined, adminAuthA);
    assert('manual channel: allowed field still written', afterManual.json.fields?.mx_human_note === 'ui-ok', JSON.stringify(afterManual.json.fields));
    assert('manual channel: blocked field not written', afterManual.json.fields?.mx_ext_ref === undefined, JSON.stringify(afterManual.json.fields));

    const apiWrite = await req(base, 'PATCH', `/v1/leads/${polLeadId}`,
      { fields: { mx_ext_ref: 'FROM-API', mx_human_note: 'api-should-be-blocked' } }, policyApiAuth);
    assert('api channel: readonlyApi field is dropped', apiWrite.status === 200 && apiWrite.json._blockedFields?.includes('mx_human_note'), JSON.stringify(apiWrite.json?._blockedFields));
    const afterApi = await req(base, 'GET', `/v1/leads/${polLeadId}`, undefined, adminAuthA);
    assert('api channel: integration-only field written', afterApi.json.fields?.mx_ext_ref === 'FROM-API', JSON.stringify(afterApi.json.fields));
    assert('api channel: human-only field unchanged', afterApi.json.fields?.mx_human_note === 'ui-ok', JSON.stringify(afterApi.json.fields));

    // ---- Custom actions ----
    let receivedActionCalls: any[] = [];
    const actionTarget = http.createServer((r, res) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { receivedActionCalls.push({ url: r.url, body: d ? JSON.parse(d) : null, headers: r.headers }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    });
    await new Promise<void>(r => actionTarget.listen(0, r));
    const actionPort = (actionTarget.address() as any).port;

    // Loopback is deliberately blocked, so creation succeeds but execution must refuse it.
    const localAction = await req(base, 'POST', '/v1/custom-actions', {
      name: 'Local Target', entity: 'lead', method: 'POST',
      urlTemplate: `http://127.0.0.1:${actionPort}/hook?p={{lead.phone}}`,
      bodyTemplate: '{"name":"{{lead.full_name}}"}',
    }, adminAuthA);
    assert('create custom action', localAction.status === 201, JSON.stringify(localAction.json));
    const execLocal = await req(base, 'POST', `/v1/custom-actions/${localAction.json.id}/execute`, { recordId: leadId }, adminAuthA);
    assert('custom action to loopback is blocked by SSRF guard', execLocal.status === 400 && ['URL_SCHEME_BLOCKED', 'URL_HOST_BLOCKED'].includes(execLocal.json.error?.code), JSON.stringify(execLocal.json));
    assert('no request reached the blocked local target', receivedActionCalls.length === 0, `${receivedActionCalls.length} calls`);

    // "Open URL" mode does no server call — merge tokens must still resolve.
    const openAction = await req(base, 'POST', '/v1/custom-actions', {
      name: 'Open Dialer', entity: 'lead', openUrlInNewTab: true,
      urlTemplate: 'https://dialer.example.com/call?to={{lead.phone}}&agent={{owner.email}}',
    }, adminAuthA);
    const execOpen = await req(base, 'POST', `/v1/custom-actions/${openAction.json.id}/execute`, { recordId: leadId }, adminAuthA);
    assert('open-url action returns a merged URL without calling out',
      execOpen.status === 200 && execOpen.json.mode === 'open_url' && execOpen.json.url.includes(encodeURIComponent('+919876543210')) === false && execOpen.json.url.includes('+919876543210'),
      JSON.stringify(execOpen.json));

    const actionsList = await req(base, 'GET', '/v1/custom-actions?entity=lead', undefined, adminAuthA);
    assert('custom actions list filters by entity', actionsList.status === 200 && actionsList.json.items.length >= 2, JSON.stringify(actionsList.json.items?.length));
    const tokenRef = await req(base, 'GET', '/v1/custom-actions/tokens/lead', undefined, adminAuthA);
    assert('merge token reference includes standard + custom fields',
      tokenRef.json.items.some((t: any) => t.token === '{{lead.phone}}') && tokenRef.json.items.some((t: any) => t.token.includes('fields.mx_city_tier')),
      JSON.stringify(tokenRef.json.items?.slice(0, 3)));

    // A user who cannot see the record must not be able to run an action against it.
    const permAction = await req(base, 'POST', '/v1/custom-actions', {
      name: 'Admin Only', entity: 'lead', openUrlInNewTab: true,
      urlTemplate: 'https://x.example.com/{{lead.id}}', requiredPermission: 'manageRoles',
    }, adminAuthA);
    const execDenied = await req(base, 'POST', `/v1/custom-actions/${permAction.json.id}/execute`, { recordId: leadId }, salesAuthFresh);
    assert('custom action respects requiredPermission', execDenied.status === 403, JSON.stringify(execDenied.json));

    // ---- Automation engine ----
    const autoRuleBad = await req(base, 'POST', '/v1/automation', {
      name: 'Bad', trigger: { entity: 'lead', event: 'field_changed' }, actions: [{ type: 'create_task', name: 'x' }],
    }, adminAuthA);
    assert('automation validates field_changed requires a field', autoRuleBad.status === 400, JSON.stringify(autoRuleBad.json));
    const autoRuleBadAction = await req(base, 'POST', '/v1/automation', {
      name: 'Bad2', trigger: { entity: 'lead', event: 'created' }, actions: [{ type: 'delete_everything' }],
    }, adminAuthA);
    assert('automation rejects unknown action types', autoRuleBadAction.status === 400, JSON.stringify(autoRuleBadAction.json));

    // Rule 1: stage → Qualified creates a task (tests stage_changed + toValue + create_task)
    const ruleStage = await req(base, 'POST', '/v1/automation', {
      name: 'Qualified follow-up',
      trigger: { entity: 'lead', event: 'stage_changed', toValue: 'Qualified' },
      actions: [{ type: 'create_task', name: 'Call {{lead.full_name}}', kind: 'todo', dueInDays: 2, ownerId: 'record_owner' }],
    }, adminAuthA);
    assert('create stage-change automation rule', ruleStage.status === 201, JSON.stringify(ruleStage.json));

    const autoLead = await req(base, 'POST', '/v1/leads', { firstName: 'Auto', lastName: 'Trigger', email: 'auto@x.com' }, adminAuthA);
    const autoLeadId = autoLead.json.lead.id;
    await req(base, 'PATCH', `/v1/leads/${autoLeadId}`, { stage: 'Contacted' }, adminAuthA);
    const tasksAfterWrongStage = await req(base, 'GET', `/v1/tasks?leadId=${autoLeadId}`, undefined, adminAuthA);
    assert('automation does not fire on a non-matching stage value', (tasksAfterWrongStage.json.items || []).length === 0, JSON.stringify(tasksAfterWrongStage.json.items?.length));

    await req(base, 'PATCH', `/v1/leads/${autoLeadId}`, { stage: 'Qualified' }, adminAuthA);
    const tasksAfterMatch = await req(base, 'GET', `/v1/tasks?leadId=${autoLeadId}`, undefined, adminAuthA);
    assert('automation fires on the matching stage value and creates a task', (tasksAfterMatch.json.items || []).length === 1, JSON.stringify(tasksAfterMatch.json.items));
    assert('automation merge tokens resolve in action config',
      tasksAfterMatch.json.items[0]?.name === 'Call Auto Trigger', JSON.stringify(tasksAfterMatch.json.items[0]?.name));

    const execLog = await req(base, 'GET', `/v1/automation/executions?ruleId=${ruleStage.json.id}`, undefined, adminAuthA);
    assert('automation execution log records the run with per-step detail',
      execLog.status === 200 && execLog.json.items.length >= 1 && execLog.json.items[0].status === 'success' && execLog.json.items[0].steps?.length === 1,
      JSON.stringify(execLog.json.items?.[0]));

    // Rule 2: custom-field change to a value updates the lead (tests field_changed + update_lead)
    const ruleField = await req(base, 'POST', '/v1/automation', {
      name: 'Tier1 priority',
      trigger: { entity: 'lead', event: 'field_changed', field: 'fields.mx_city_tier', toValue: 'Tier1' },
      actions: [{ type: 'update_lead', patch: { fields: { mx_ext_ref: 'AUTO-TIER1' } } }],
    }, adminAuthA);
    assert('create field-change automation rule', ruleField.status === 201, JSON.stringify(ruleField.json));
    await req(base, 'PATCH', `/v1/leads/${autoLeadId}`, { fields: { mx_city_tier: 'Tier2' } }, adminAuthA);
    const afterTier2 = await req(base, 'GET', `/v1/leads/${autoLeadId}`, undefined, adminAuthA);
    assert('field-change rule ignores a non-matching value', afterTier2.json.fields?.mx_ext_ref === undefined, JSON.stringify(afterTier2.json.fields));
    await req(base, 'PATCH', `/v1/leads/${autoLeadId}`, { fields: { mx_city_tier: 'Tier1' } }, adminAuthA);
    const afterTier1 = await req(base, 'GET', `/v1/leads/${autoLeadId}`, undefined, adminAuthA);
    assert('field-change rule fires on the matching value and updates the record',
      afterTier1.json.fields?.mx_ext_ref === 'AUTO-TIER1', JSON.stringify(afterTier1.json.fields));

    // Rule 3: activity-type-specific trigger
    const ruleActivity = await req(base, 'POST', '/v1/automation', {
      name: 'Log incoming calls',
      trigger: { entity: 'activity', event: 'created', activityTypeId: actTypeResp.json.id },
      actions: [{ type: 'create_task', name: 'Post-visit follow-up', dueInDays: 1 }],
    }, adminAuthA);
    assert('create activity-type automation rule', ruleActivity.status === 201, JSON.stringify(ruleActivity.json));
    await req(base, 'POST', '/v1/activities', { leadId: autoLeadId, typeId: actTypeResp.json.id, note: 'visit', fields: { mx_property: 'X' } }, adminAuthA);
    const tasksAfterActivity = await req(base, 'GET', `/v1/tasks?leadId=${autoLeadId}`, undefined, adminAuthA);
    assert('activity-triggered automation creates its task',
      (tasksAfterActivity.json.items || []).some((t: any) => t.name === 'Post-visit follow-up'), JSON.stringify(tasksAfterActivity.json.items?.map((t: any) => t.name)));

    // Loop protection: a rule whose action re-triggers itself must not run away.
    const ruleLoop = await req(base, 'POST', '/v1/automation', {
      name: 'Self triggering',
      trigger: { entity: 'lead', event: 'field_changed', field: 'fields.mx_loop' },
      actions: [{ type: 'update_lead', patch: { fields: { mx_loop: 'again' } } }],
      maxExecutionsPerRecord: 3,
    }, adminAuthA);
    await req(base, 'POST', '/v1/fields/lead', { label: 'Loop', type: 'text' }, adminAuthA);
    const loopLead = await req(base, 'POST', '/v1/leads', { firstName: 'Loopy', email: 'loop@x.com' }, adminAuthA);
    const loopPatch = await req(base, 'PATCH', `/v1/leads/${loopLead.json.lead.id}`, { fields: { mx_loop: 'start' } }, adminAuthA);
    assert('self-triggering rule does not hang or crash the request', loopPatch.status === 200, JSON.stringify(loopPatch.json?.error));
    const loopExecs = await req(base, 'GET', `/v1/automation/executions?ruleId=${ruleLoop.json.id}&limit=100`, undefined, adminAuthA);
    assert('loop protection bounds executions (depth + per-record ceiling)',
      loopExecs.json.items.length > 0 && loopExecs.json.items.length <= 6, `${loopExecs.json.items.length} executions`);

    // http_call action + outbound call log
    const ruleHttp = await req(base, 'POST', '/v1/automation', {
      name: 'Notify external',
      trigger: { entity: 'lead', event: 'field_changed', field: 'fields.mx_ext_ref', toValue: 'PING' },
      actions: [{ type: 'http_call', method: 'POST', url: 'https://127.0.0.1/blocked', body: '{"id":"{{lead.id}}"}' }],
    }, adminAuthA);
    await req(base, 'PATCH', `/v1/leads/${autoLeadId}`, { fields: { mx_ext_ref: 'PING' } }, adminAuthA);
    const httpExecs = await req(base, 'GET', `/v1/automation/executions?ruleId=${ruleHttp.json.id}`, undefined, adminAuthA);
    assert('http_call action failure is recorded as a failed step, not a crashed request',
      httpExecs.json.items.length >= 1 && httpExecs.json.items[0].status === 'failed', JSON.stringify(httpExecs.json.items?.[0]?.steps));

    // Paused rules must not fire.
    await req(base, 'PATCH', `/v1/automation/${ruleStage.json.id}`, { isActive: false }, adminAuthA);
    const pausedLead = await req(base, 'POST', '/v1/leads', { firstName: 'Paused', email: 'paused@x.com' }, adminAuthA);
    await req(base, 'PATCH', `/v1/leads/${pausedLead.json.lead.id}`, { stage: 'Qualified' }, adminAuthA);
    const pausedTasks = await req(base, 'GET', `/v1/tasks?leadId=${pausedLead.json.lead.id}`, undefined, adminAuthA);
    assert('paused automation rule does not fire', (pausedTasks.json.items || []).length === 0, JSON.stringify(pausedTasks.json.items?.length));

    // ---- API-sourced dropdown options ----
    const optionsServer = http.createServer((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { items: [{ id: 'PN', name: 'Pune' }, { id: 'MU', name: 'Mumbai' }] } }));
    });
    await new Promise<void>(r => optionsServer.listen(0, r));
    const optPort = (optionsServer.address() as any).port;

    const apiField = await req(base, 'POST', '/v1/fields/lead', {
      label: 'Api City', type: 'dropdown', optionsSource: 'api',
      optionsApi: { url: `http://127.0.0.1:${optPort}/opts`, jsonPath: 'data.items', labelKey: 'name', valueKey: 'id' },
    }, adminAuthA);
    assert('create API-sourced dropdown field', apiField.status === 201 && apiField.json.options_source === 'api', JSON.stringify(apiField.json));
    const optResolve = await req(base, 'GET', '/v1/fields/lead/mx_api_city/options', undefined, adminAuthA);
    assert('API option resolution is SSRF-guarded (loopback refused)',
      optResolve.status === 400 || optResolve.status === 502, JSON.stringify(optResolve.json));
    const staticOpts = await req(base, 'GET', '/v1/fields/lead/mx_city_tier/options', undefined, adminAuthA);
    assert('static field options resolve normally',
      staticOpts.status === 200 && staticOpts.json.source === 'static' && staticOpts.json.items.length === 3, JSON.stringify(staticOpts.json));
    const apiFieldNoUrl = await req(base, 'POST', '/v1/fields/lead', { label: 'Bad Api', type: 'dropdown', optionsSource: 'api', optionsApi: {} }, adminAuthA);
    assert('API-sourced field requires a url', apiFieldNoUrl.status === 400, JSON.stringify(apiFieldNoUrl.json));
    const apiFieldWrongType = await req(base, 'POST', '/v1/fields/lead', { label: 'Bad Api Text', type: 'text', optionsSource: 'api', optionsApi: { url: 'https://x.com' } }, adminAuthA);
    assert('API-sourced options rejected on non-choice field types', apiFieldWrongType.status === 400, JSON.stringify(apiFieldWrongType.json));

    // ---- Unified capture API ----
    const capNew = await req(base, 'POST', '/v1/capture', {
      lead: { searchBy: 'phone', phone: '+918888800001', firstName: 'Cap', lastName: 'One', createIfNotFound: true },
      activity: { typeName: 'Incoming Call', note: 'First call', fields: {} },
    }, adminAuthA);
    assert('unified capture creates a lead + logs an activity',
      capNew.status === 201 && capNew.json.lead?.created === true && capNew.json.activity?.id, JSON.stringify(capNew.json));
    const capLeadId = capNew.json.lead.id;

    const capUpdate = await req(base, 'POST', '/v1/capture', {
      lead: { searchBy: 'phone', phone: '+918888800001', lastName: 'Updated' },
    }, adminAuthA);
    assert('unified capture updates the matched lead instead of duplicating',
      capUpdate.status === 201 && capUpdate.json.lead.created === false && capUpdate.json.lead.id === capLeadId, JSON.stringify(capUpdate.json));

    const capNoLocator = await req(base, 'POST', '/v1/capture', { lead: { firstName: 'NoLocator' } }, adminAuthA);
    assert('unified capture demands a unique locator', capNoLocator.status === 400, JSON.stringify(capNoLocator.json));

    const capNoCreate = await req(base, 'POST', '/v1/capture', {
      lead: { searchBy: 'phone', phone: '+919999900009', createIfNotFound: false, firstName: 'Ghost' },
    }, adminAuthA);
    assert('createIfNotFound:false returns 404 rather than creating', capNoCreate.status === 404 && capNoCreate.json.error?.code === 'LEAD_NOT_FOUND', JSON.stringify(capNoCreate.json));

    const capOppSkip = await req(base, 'POST', '/v1/capture', {
      lead: { searchBy: 'phone', phone: '+918888800001' },
      opportunity: { searchBy: 'field', searchField: 'mx_order_id', searchValue: 'NOPE-1' },
    }, adminAuthA);
    assert('opportunity defaults to not creating when no match is found',
      capOppSkip.json.opportunity?.skipped, JSON.stringify(capOppSkip.json.opportunity));

    const capOppCreate = await req(base, 'POST', '/v1/capture', {
      lead: { searchBy: 'phone', phone: '+918888800001' },
      opportunity: { opportunityTypeId: oppType.json.id, name: 'Cap Opp', createIfNotFound: true, amount: 1000, stage: 'Proposal' },
      activity: { typeName: 'Outbound Call', note: 'Pitched' },
    }, adminAuthA);
    assert('unified capture creates an opportunity + activity together',
      capOppCreate.status === 201 && capOppCreate.json.opportunity?.created === true && capOppCreate.json.activity?.id, JSON.stringify(capOppCreate.json));
    const capOppId = capOppCreate.json.opportunity.id;

    const capOppUpdate = await req(base, 'POST', '/v1/capture', {
      lead: { searchBy: 'phone', phone: '+918888800001' },
      opportunity: { id: capOppId, stage: 'Closed Won' },
    }, adminAuthA);
    assert('unified capture updates an existing opportunity by id',
      capOppUpdate.json.opportunity?.updated === true, JSON.stringify(capOppUpdate.json.opportunity));
    const capOppCheck = await req(base, 'GET', `/v1/opportunities?leadId=${capLeadId}`, undefined, adminAuthA);
    const capOppRow = capOppCheck.json.items.find((o: any) => o.id === capOppId);
    assert('opportunity stage change through capture also flips status to Won',
      capOppRow?.stage === 'Closed Won' && capOppRow?.status === 'Won', JSON.stringify(capOppRow));

    // Field write policy must apply on the capture path too (not just PATCH).
    const capPolicy = await req(base, 'POST', '/v1/capture', {
      lead: { searchBy: 'phone', phone: '+918888800001', fields: { mx_human_note: 'via-api' } },
    }, policyApiAuth);
    assert('capture path enforces the channel field policy',
      capPolicy.status === 201 && capPolicy.json.lead?.blockedFields?.includes('mx_human_note'), JSON.stringify(capPolicy.json.lead));

    optionsServer.close();
    actionTarget.close();

    // =========================================================================================
    // Batch 5: credential encryption, per-tenant quota, telephony screen-pop, messaging
    // connectors, embedded widgets + HTML sanitizer, bulk APIs, scheduled distribution.
    // =========================================================================================

    // ---- Credential encryption (AES-256-GCM) ----
    const secretRoundTrip = decryptSecrets(encryptSecrets({ apiKey: 'super-secret-123', nested: { a: 1 } }));
    assert('credentials encrypt/decrypt round-trip', secretRoundTrip.apiKey === 'super-secret-123' && secretRoundTrip.nested?.a === 1, JSON.stringify(secretRoundTrip));
    const blob = encryptSecrets({ apiKey: 'abc' });
    assert('ciphertext does not contain the plaintext', !blob.includes('abc') && blob.startsWith('v1:'), blob.slice(0, 24));
    let tamperCaught = false;
    try {
      const parts = blob.split(':');
      // Flip a byte in the ciphertext — GCM's auth tag must reject it.
      const ct = Buffer.from(parts[3], 'base64'); ct[0] ^= 0xff;
      decryptSecrets([parts[0], parts[1], parts[2], ct.toString('base64')].join(':'));
    } catch { tamperCaught = true; }
    assert('tampered ciphertext is rejected (GCM auth tag)', tamperCaught);
    assert('secret masking never reveals the full value',
      maskSecret('super-secret-123') === 'sup••••23' && !maskSecret('super-secret-123').includes('secret'),
      maskSecret('super-secret-123'));

    // ---- Per-tenant API rate limiting + daily quota ----
    await req(base, 'PATCH', `/host/api/tenants/${tenantAResp.json.id}/limits`,
      { apiRateOverride: 3, apiBurstSeconds: 5, apiDailyQuotaOverride: 100000 }, hostAuth);
    invalidateLimits(tenantAResp.json.id);
    const limitsRead = await req(base, 'GET', `/host/api/tenants/${tenantAResp.json.id}/limits`, undefined, hostAuth);
    assert('host admin can read/set per-tenant API limits',
      limitsRead.status === 200 && limitsRead.json.effective.ratePerWindow === 3, JSON.stringify(limitsRead.json?.effective));

    const quotaStatuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await req(base, 'GET', '/v1/leads?limit=1', undefined, adminAuthA);
      quotaStatuses.push(r.status);
    }
    assert('per-tenant rate limit returns 429 past the configured burst',
      quotaStatuses.includes(429), JSON.stringify(quotaStatuses));
    assert('rate limiting is per tenant, not global (tenant B unaffected)',
      (await req(base, 'GET', '/v1/leads?limit=1', undefined, adminAuthB)).status === 200);

    // Raise the limit again so the remaining checks aren't throttled.
    await req(base, 'PATCH', `/host/api/tenants/${tenantAResp.json.id}/limits`,
      { apiRateOverride: 100000, apiDailyQuotaOverride: 1000000 }, hostAuth);
    invalidateLimits(tenantAResp.json.id);

    const badLimit = await req(base, 'PATCH', `/host/api/tenants/${tenantAResp.json.id}/limits`, { apiRateOverride: -5 }, hostAuth);
    assert('invalid limit values rejected', badLimit.status === 400, JSON.stringify(badLimit.json));

    // Quota accounting is multi-process safe because it's a single atomic statement.
    const q1 = await consumeQuota(tenantBResp.json.id);
    const q2 = await consumeQuota(tenantBResp.json.id);
    assert('quota counter increments atomically', q2.windowCalls > q1.windowCalls && q2.dailyCalls > q1.dailyCalls,
      `${q1.windowCalls}->${q2.windowCalls}, ${q1.dailyCalls}->${q2.dailyCalls}`);

    // ---- UI version (staged rollout) ----
    const uiSet = await req(base, 'PATCH', `/host/api/tenants/${tenantAResp.json.id}/ui-version`, { uiVersion: 2 }, hostAuth);
    assert('host admin can set a tenant UI version', uiSet.status === 200 && uiSet.json.ui_version === 2, JSON.stringify(uiSet.json));
    const meUi = await req(base, 'GET', '/v1/me', undefined, adminAuthA);
    assert('uiVersion is exposed to the client for staged rollout', meUi.json.uiVersion === 2, JSON.stringify({ uiVersion: meUi.json?.uiVersion }));
    const meUiB = await req(base, 'GET', '/v1/me', undefined, adminAuthB);
    assert('other tenants keep the current UI version', meUiB.json.uiVersion === 1, JSON.stringify({ uiVersion: meUiB.json?.uiVersion }));
    const badUi = await req(base, 'PATCH', `/host/api/tenants/${tenantAResp.json.id}/ui-version`, { uiVersion: 99 }, hostAuth);
    assert('invalid UI version rejected', badUi.status === 400, JSON.stringify(badUi.json));
    await req(base, 'PATCH', `/host/api/tenants/${tenantAResp.json.id}/ui-version`, { uiVersion: 1 }, hostAuth);

    // ---- Telephony screen-pop ----
    const telLocked = await req(base, 'POST', '/v1/telephony/call-started',
      { phone: '+919876543210', agentValue: 'admin@acme.local' }, adminAuthA);
    assert('telephony is a paid feature and locked by default', telLocked.status === 402, JSON.stringify(telLocked.json));
    await req(base, 'PUT', `/host/api/tenants/${tenantAResp.json.id}/entitlements/telephony`, { isEnabled: true }, hostAuth);

    const telNoAgent = await req(base, 'POST', '/v1/telephony/call-started', { phone: '+919876543210' }, adminAuthA);
    assert('call-started requires an agent locator', telNoAgent.status === 400, JSON.stringify(telNoAgent.json));
    const telBadAgent = await req(base, 'POST', '/v1/telephony/call-started',
      { phone: '+919876543210', agentField: 'email', agentValue: 'nobody@nowhere.local' }, adminAuthA);
    assert('unknown agent is a clean 404', telBadAgent.status === 404 && telBadAgent.json.error?.code === 'AGENT_NOT_FOUND', JSON.stringify(telBadAgent.json));

    const telPop = await req(base, 'POST', '/v1/telephony/call-started',
      { phone: '+919876543210', agentField: 'email', agentValue: 'admin@acme.local', callId: 'CALL-1' }, adminAuthA);
    assert('screen-pop matches the caller to a lead and targets one agent',
      telPop.status === 200 && telPop.json.matched === true && telPop.json.agentId && telPop.json.navigateTo?.startsWith('/leads/'),
      JSON.stringify(telPop.json));
    assert('screen-pop event is persisted so it survives an offline agent', !!telPop.json.eventId, JSON.stringify(telPop.json?.eventId));

    // Agent resolution via a unique user custom field (the documented mechanism).
    await req(base, 'PATCH', `/v1/users/${salesUserId}`, { fields: { mx_employee_code: 'EMP-777' } }, adminAuthA);
    const telByCode = await req(base, 'POST', '/v1/telephony/call-started',
      { phone: '+919876543210', agentField: 'mx_employee_code', agentValue: 'EMP-777' }, adminAuthA);
    assert('agent can be identified by a unique user custom field',
      telByCode.status === 200 && telByCode.json.agentId === salesUserId, JSON.stringify(telByCode.json));

    const nonUniqueField = await req(base, 'POST', '/v1/fields/user', { label: 'Team Name', type: 'text' }, adminAuthA);
    const telNonUnique = await req(base, 'POST', '/v1/telephony/call-started',
      { phone: '+919876543210', agentField: nonUniqueField.json.schema_name, agentValue: 'x' }, adminAuthA);
    assert('non-unique user field is refused as an agent locator',
      telNonUnique.status === 400 && telNonUnique.json.error?.code === 'AGENT_FIELD_NOT_UNIQUE', JSON.stringify(telNonUnique.json));

    const telUnknownCaller = await req(base, 'POST', '/v1/telephony/call-started',
      { phone: '+910000000000', agentField: 'email', agentValue: 'admin@acme.local' }, adminAuthA);
    assert('unknown caller still pops (so the agent can create the lead)',
      telUnknownCaller.status === 200 && telUnknownCaller.json.matched === false, JSON.stringify(telUnknownCaller.json));

    const telLookup = await req(base, 'GET', '/v1/telephony/lookup?phone=%2B919876543210', undefined, adminAuthA);
    assert('telephony lookup resolves a number without pushing an event',
      telLookup.status === 200 && telLookup.json.count >= 1, JSON.stringify({ count: telLookup.json?.count }));

    const eventsStatus = await req(base, 'GET', '/v1/events/status', undefined, adminAuthA);
    assert('event stream status endpoint responds', eventsStatus.status === 200 && 'connected' in eventsStatus.json, JSON.stringify(eventsStatus.json));

    // ---- Messaging connectors (customer's own provider) ----
    const provList = await req(base, 'GET', '/v1/messaging/providers', undefined, adminAuthA);
    assert('provider catalogue lists the supported providers',
      provList.status === 200 && provList.json.items.some((p: any) => p.key === 'gupshup') && provList.json.encryptionReady === true,
      JSON.stringify(provList.json.items?.map((p: any) => p.key)));

    const connBadChannel = await req(base, 'POST', '/v1/messaging/connectors',
      { name: 'Bad', provider: 'sendgrid', channel: 'sms' }, adminAuthA);
    assert('provider/channel mismatch rejected', connBadChannel.status === 400, JSON.stringify(connBadChannel.json));

    const smsConn = await req(base, 'POST', '/v1/messaging/connectors', {
      name: 'Gupshup SMS', provider: 'gupshup', channel: 'sms',
      config: { source: '911234567890', appName: 'AcmeApp', userId: 'acme' },
      secrets: { apiKey: 'gupshup-secret-key' },
    }, adminAuthA);
    assert('create a messaging connector with the tenant\'s own credentials', smsConn.status === 201, JSON.stringify(smsConn.json));
    assert('connector response never contains the credential',
      !JSON.stringify(smsConn.json).includes('gupshup-secret-key'), JSON.stringify(smsConn.json));

    const connList = await req(base, 'GET', '/v1/messaging/connectors', undefined, adminAuthA);
    const listedConn = connList.json.items.find((x: any) => x.id === smsConn.json.id);
    assert('connector list reports credentials present without exposing them',
      listedConn?.has_credentials === true && !JSON.stringify(connList.json).includes('gupshup-secret-key'),
      JSON.stringify(listedConn));
    const credPreview = await req(base, 'GET', `/v1/messaging/connectors/${smsConn.json.id}/credentials`, undefined, adminAuthA);
    assert('credential preview is masked only',
      credPreview.status === 200 && credPreview.json.masked.apiKey && !credPreview.json.masked.apiKey.includes('secret'),
      JSON.stringify(credPreview.json));

    const tpl = await req(base, 'POST', '/v1/messaging/templates', {
      name: 'Welcome SMS', channel: 'sms', body: 'Hi {{lead.first_name}}, thanks for your interest in {{lead.fields.mx_city_tier}}!',
    }, adminAuthA);
    assert('create a message template with merge tokens', tpl.status === 201, JSON.stringify(tpl.json));

    // The real provider is unreachable from the sandbox, so this asserts the pipeline runs and
    // the failure is captured in the message log rather than throwing.
    const sendAttempt = await req(base, 'POST', '/v1/messaging/send',
      { channel: 'sms', templateId: tpl.json.id, leadId }, adminAuthA);
    assert('send pipeline executes and reports provider outcome',
      [200, 502].includes(sendAttempt.status), JSON.stringify(sendAttempt.json));
    const msgLog = await req(base, 'GET', `/v1/messaging/log?leadId=${leadId}`, undefined, adminAuthA);
    assert('every send attempt is logged with its outcome',
      msgLog.status === 200 && msgLog.json.items.length >= 1, JSON.stringify(msgLog.json.items?.[0]));
    assert('message log stores the merged body, not the raw template',
      !String(msgLog.json.items[0]?.subject || '').includes('{{'), JSON.stringify(msgLog.json.items[0]));

    const sendNoConnector = await req(base, 'POST', '/v1/messaging/send',
      { channel: 'whatsapp', body: 'hi', leadId }, adminAuthA);
    assert('sending without a configured connector gives a clear error',
      sendNoConnector.status === 400 && sendNoConnector.json.error?.code === 'NO_CONNECTOR', JSON.stringify(sendNoConnector.json));

    // ---- Embedded widgets + HTML sanitizer ----
    const dirty = `<div>ok</div><script>steal(document.cookie)</script><img src=x onerror="alert(1)"><a href="javascript:alert(2)">x</a><iframe src="https://evil.com"></iframe>`;
    const clean = sanitizeHtml(dirty);
    assert('sanitizer strips script tags', !/<script/i.test(clean.html), clean.html);
    assert('sanitizer strips inline event handlers', !/onerror/i.test(clean.html), clean.html);
    assert('sanitizer strips javascript: URLs', !/javascript:/i.test(clean.html), clean.html);
    assert('sanitizer strips nested iframes', !/<iframe/i.test(clean.html), clean.html);
    assert('sanitizer keeps benign markup', clean.html.includes('<div>ok</div>'), clean.html);

    const widgetLocked = await req(base, 'POST', '/v1/widgets',
      { name: 'X', placement: 'lead_tab', urlTemplate: 'https://example.com' }, adminAuthA);
    assert('custom apps/widgets are a paid feature', widgetLocked.status === 402, JSON.stringify(widgetLocked.json));
    await req(base, 'PUT', `/host/api/tenants/${tenantAResp.json.id}/entitlements/custom_apps`, { isEnabled: true }, hostAuth);

    const widgetHttp = await req(base, 'POST', '/v1/widgets',
      { name: 'Insecure', placement: 'lead_tab', urlTemplate: 'http://example.com' }, adminAuthA);
    assert('embedded URLs must be https', widgetHttp.status === 400, JSON.stringify(widgetHttp.json));

    const widget = await req(base, 'POST', '/v1/widgets', {
      name: 'Lead Dashboard', placement: 'lead_tab',
      urlTemplate: 'https://reports.example.com/lead?id={{lead.id}}&phone={{lead.phone}}&agent={{user.email}}',
      height: 400,
    }, adminAuthA);
    assert('create an iframe widget with merge tokens', widget.status === 201, JSON.stringify(widget.json));
    const widgetResolved = await req(base, 'GET', `/v1/widgets/${widget.json.id}/resolve?recordId=${leadId}&entity=lead`, undefined, adminAuthA);
    assert('widget URL is merged with record + user context server-side',
      widgetResolved.status === 200 && widgetResolved.json.url.includes(leadId) && !widgetResolved.json.url.includes('{{'),
      JSON.stringify(widgetResolved.json));

    const htmlWidget = await req(base, 'POST', '/v1/widgets', {
      name: 'Notice', kind: 'html', placement: 'lead_sidebar',
      htmlContent: '<p>Call before 6pm</p><script>bad()</script>',
    }, adminAuthA);
    assert('html widget is sanitized on save and reports what was removed',
      htmlWidget.status === 201 && !String(htmlWidget.json.html_content).includes('<script') && htmlWidget.json._sanitized?.length,
      JSON.stringify({ html: htmlWidget.json?.html_content, sanitized: htmlWidget.json?._sanitized }));

    // A widget must not become a way to read records the user can't see.
    const widgetScoped = await req(base, 'GET', `/v1/widgets/${widget.json.id}/resolve?recordId=${leadR2?.json?.lead?.id || leadId}&entity=lead`, undefined, adminAuthB);
    assert('widget resolve is tenant/scope checked', [403, 404].includes(widgetScoped.status), JSON.stringify(widgetScoped.json));

    // ---- Bulk APIs ----
    const bulkLeads = await req(base, 'POST', '/v1/bulk/leads', {
      rows: [
        { email: 'bulk-x1@acme.local', firstName: 'BX', lastName: 'One', fields: { mx_city_tier: 'Tier1' } },
        { email: 'bulk-x2@acme.local', firstName: 'BX', lastName: 'Two' },
        { firstName: 'NoLocator' },                              // must fail per-row, not abort the batch
        { email: 'bulk-x1@acme.local', lastName: 'OneUpdated' },  // should update, not duplicate
      ],
    }, adminAuthA);
    assert('bulk lead upsert creates, updates and reports per-row errors',
      bulkLeads.status === 201 && bulkLeads.json.created === 2 && bulkLeads.json.updated === 1 && bulkLeads.json.failed === 1,
      JSON.stringify({ c: bulkLeads.json?.created, u: bulkLeads.json?.updated, f: bulkLeads.json?.failed }));
    assert('bulk-created leads get an owner from distribution/default-owner rules',
      bulkLeads.json.results.filter((r: any) => r.status === 'created').every((r: any) => !!r.ownerId),
      JSON.stringify(bulkLeads.json.results));

    const bulkOpps = await req(base, 'POST', '/v1/bulk/opportunities', {
      rows: [
        { email: 'bulk-opp-new@acme.local', firstName: 'OppLead', name: 'Bulk Opp A', amount: 5000, opportunityTypeId: oppType.json.id },
        { email: 'bulk-x1@acme.local', name: 'Bulk Opp B', amount: 1000, opportunityTypeId: oppType.json.id },
      ],
      createLeadIfMissing: true,
    }, adminAuthA);
    assert('bulk opportunity import creates the parent lead when missing',
      bulkOpps.status === 201 && bulkOpps.json.created === 2 && bulkOpps.json.results.some((r: any) => r.leadCreated === true),
      JSON.stringify(bulkOpps.json.results));

    const bulkOppNoLead = await req(base, 'POST', '/v1/bulk/opportunities', {
      rows: [{ email: 'definitely-absent@acme.local', name: 'Orphan', opportunityTypeId: oppType.json.id }],
      createLeadIfMissing: false,
    }, adminAuthA);
    assert('opportunity import refuses to orphan a row when lead creation is off',
      bulkOppNoLead.json.failed === 1, JSON.stringify(bulkOppNoLead.json.results));

    const bulkActs = await req(base, 'POST', '/v1/bulk/activities', {
      rows: [{ email: 'bulk-x1@acme.local', typeName: 'Site Visit', note: 'bulk visit', fields: { mx_property: 'P1' } }],
    }, adminAuthA);
    assert('bulk activity import attaches to the resolved lead',
      bulkActs.status === 201 && bulkActs.json.created === 1, JSON.stringify(bulkActs.json.results));

    const oppCsv = 'Email,Name,Amount\nbulk-csv@acme.local,CSV Opp,7500\n';
    const oppImport = await req(base, 'POST', '/v1/bulk/import/opportunities', {
      csv: oppCsv,
      fieldMap: { Email: 'lead.email', Name: 'name', Amount: 'amount' },
      searchBy: 'email', createLeadIfMissing: true, opportunityTypeId: oppType.json.id,
    }, adminAuthA);
    assert('CSV opportunity import works through the same path as the JSON API',
      oppImport.status === 201 && oppImport.json.created === 1, JSON.stringify(oppImport.json));

    // ---- Scheduled (batch) lead distribution ----
    await req(base, 'PATCH', '/v1/settings/tenant', { distributionMode: 'scheduled' }, adminAuthB);
    const schedLead = await req(base, 'POST', '/v1/leads', { firstName: 'Sched', email: 'sched@beta.local' }, adminAuthB);
    assert('in scheduled mode new leads are deliberately left unassigned',
      !schedLead.json.lead.owner_id, JSON.stringify({ owner: schedLead.json.lead?.owner_id }));
    const sweptCount = await runScheduledDistribution(tenantBResp.json.id);
    assert('the scheduled sweep assigns the backlog', sweptCount >= 1, `assigned ${sweptCount}`);
    const schedAfter = await req(base, 'GET', `/v1/leads/${schedLead.json.lead.id}`, undefined, adminAuthB);
    assert('previously-unassigned lead now has an owner', !!schedAfter.json.owner_id, JSON.stringify({ owner: schedAfter.json?.owner_id }));
    const runNow = await req(base, 'POST', '/v1/distribution-rules/run-now', {}, adminAuthB);
    assert('distribution can also be triggered on demand', runNow.status === 200, JSON.stringify(runNow.json));
    await req(base, 'PATCH', '/v1/settings/tenant', { distributionMode: 'realtime' }, adminAuthB);
    const badDistMode = await req(base, 'PATCH', '/v1/settings/tenant', { distributionMode: 'weekly' }, adminAuthB);
    assert('invalid distribution mode rejected', badDistMode.status === 400, JSON.stringify(badDistMode.json));

    // =========================================================================================
    // Batch 6: named UI variants, audit retention + settings audit + API logging, payments.
    // =========================================================================================

    // ---- Named, branchable UI variants ----
    const varList0 = await req(base, 'GET', '/host/api/ui-variants', undefined, hostAuth);
    assert('a default UI variant exists', varList0.status === 200 && varList0.json.items.some((v: any) => v.key === 'classic' && v.is_default), JSON.stringify(varList0.json.items?.map((v: any) => v.key)));

    const v2 = await req(base, 'POST', '/host/api/ui-variants', {
      key: 'refresh-2026', name: '2026 Refresh', parentKey: 'classic',
      config: { newNav: true, denseTables: true }, status: 'testing',
    }, hostAuth);
    assert('branch a new variant from the default', v2.status === 201 && v2.json.parent_id && v2.json.config.newNav === true, JSON.stringify(v2.json));

    // The key scenario: branch a THIRD variant from the ORIGINAL, not from the newest.
    const v3 = await req(base, 'POST', '/host/api/ui-variants', {
      key: 'classic-plus', name: 'Classic Plus', parentKey: 'classic',
      config: { compactSidebar: true },
    }, hostAuth);
    assert('branch a third variant from the original (not the newest)', v3.status === 201, JSON.stringify(v3.json));
    assert('branching from classic does NOT inherit the 2026 Refresh changes',
      v3.json.config.newNav === undefined && v3.json.config.compactSidebar === true, JSON.stringify(v3.json.config));

    const dupVar = await req(base, 'POST', '/host/api/ui-variants', { key: 'refresh-2026', name: 'Dup' }, hostAuth);
    assert('duplicate variant key rejected', dupVar.status === 409, JSON.stringify(dupVar.json));
    const badKey = await req(base, 'POST', '/host/api/ui-variants', { key: 'Bad Key!', name: 'x' }, hostAuth);
    assert('invalid variant key rejected', badKey.status === 400, JSON.stringify(badKey.json));

    // Assign per tenant — the whole point.
    const assignA = await req(base, 'PUT', `/host/api/ui-variants/assign/${tenantAResp.json.id}`, { variantKey: 'refresh-2026' }, hostAuth);
    assert('assign a variant to one tenant', assignA.status === 200 && assignA.json.variant.key === 'refresh-2026', JSON.stringify(assignA.json));
    const myVarA = await req(base, 'GET', '/v1/ui-variant', undefined, adminAuthA);
    assert('tenant sees its assigned variant + config flags',
      myVarA.status === 200 && myVarA.json.key === 'refresh-2026' && myVarA.json.config.newNav === true, JSON.stringify(myVarA.json));
    const myVarB = await req(base, 'GET', '/v1/ui-variant', undefined, adminAuthB);
    assert('other tenants stay on the default variant', myVarB.json.key === 'classic', JSON.stringify(myVarB.json));

    // Renaming must not break tenants (they point at the id, not the label).
    const renamed = await req(base, 'PATCH', '/host/api/ui-variants/refresh-2026', { name: 'Modern UI', status: 'released' }, hostAuth);
    assert('a variant can be renamed and re-tagged', renamed.status === 200 && renamed.json.name === 'Modern UI', JSON.stringify(renamed.json));
    const afterRename = await req(base, 'GET', '/v1/ui-variant', undefined, adminAuthA);
    assert('renaming does not detach assigned tenants', afterRename.json.key === 'refresh-2026', JSON.stringify(afterRename.json));

    const delInUse = await req(base, 'DELETE', '/host/api/ui-variants/refresh-2026', undefined, hostAuth);
    assert('a variant in use cannot be deleted', delInUse.status === 400 && delInUse.json.error?.code === 'VARIANT_IN_USE', JSON.stringify(delInUse.json));
    const delDefault = await req(base, 'DELETE', '/host/api/ui-variants/classic', undefined, hostAuth);
    assert('the default variant cannot be deleted', delDefault.status === 400, JSON.stringify(delDefault.json));

    const rollout = await req(base, 'GET', '/host/api/ui-variants/rollout', undefined, hostAuth);
    assert('rollout view shows which tenants are on which variant',
      rollout.status === 200 && rollout.json.items.some((r: any) => r.key === 'refresh-2026' && r.tenants.length >= 1), JSON.stringify(rollout.json.items?.map((r: any) => ({ k: r.key, n: r.tenants.length }))));

    // ---- Settings-level audit ----
    await req(base, 'PATCH', '/v1/settings/tenant', { cascadeOwnerToTask: false }, adminAuthA);
    const settingsAudit = await req(base, 'GET', '/v1/audit?entity=settings', undefined, adminAuthA);
    assert('settings changes are audited with who/when',
      settingsAudit.status === 200 && settingsAudit.json.items.some((a: any) => a.action === 'settings.updated'),
      JSON.stringify(settingsAudit.json.items?.[0]?.action));
    const auditDetail = await req(base, 'GET', `/v1/audit/${settingsAudit.json.items[0].id}`, undefined, adminAuthA);
    assert('settings audit records exactly which keys changed',
      auditDetail.status === 200 && auditDetail.json.after?.changed?.cascadeOwnerToTask, JSON.stringify(auditDetail.json.after?.changed));
    await req(base, 'PATCH', '/v1/settings/tenant', { cascadeOwnerToTask: true }, adminAuthA);

    // ---- Retention is a billable limit: tenants can't raise it themselves ----
    const selfRaise = await req(base, 'PATCH', '/v1/settings/tenant', { retention: { apiLogDays: 365 } }, adminAuthA);
    assert('tenants cannot raise their own log retention',
      selfRaise.status === 403 && selfRaise.json.error?.code === 'HOST_MANAGED_SETTING', JSON.stringify(selfRaise.json));
    const retRead = await req(base, 'GET', `/host/api/tenants/${tenantAResp.json.id}/retention`, undefined, hostAuth);
    assert('host admin can read retention + current log volume',
      retRead.status === 200 && retRead.json.retention.apiLogDays === 7 && 'apiLogRows' in retRead.json.usage, JSON.stringify(retRead.json));
    const retSet = await req(base, 'PATCH', `/host/api/tenants/${tenantAResp.json.id}/retention`, { apiLogDays: 30, settingsAuditDays: 90 }, hostAuth);
    assert('host admin can raise retention (the paid upgrade)',
      retSet.status === 200 && retSet.json.retention.apiLogDays === 30, JSON.stringify(retSet.json));
    const retBad = await req(base, 'PATCH', `/host/api/tenants/${tenantAResp.json.id}/retention`, { apiLogDays: 99999 }, hostAuth);
    assert('absurd retention values rejected', retBad.status === 400, JSON.stringify(retBad.json));
    const retForever = await req(base, 'PATCH', `/host/api/tenants/${tenantAResp.json.id}/retention`, { recordAuditDays: null }, hostAuth);
    assert('record audit can be set to keep-forever (null)', retForever.status === 200, JSON.stringify(retForever.json));

    // ---- API request logging + redaction ----
    const redacted = redact({ email: 'a@b.com', password: 'hunter2', nested: { apiKey: 'sk_live_x', ok: 1 }, cardNumber: '4111111111111111' });
    assert('log redaction removes passwords/keys/card data',
      redacted.password === '[REDACTED]' && redacted.nested.apiKey === '[REDACTED]' && redacted.cardNumber === '[REDACTED]',
      JSON.stringify(redacted));
    assert('log redaction keeps non-sensitive fields', redacted.email === 'a@b.com' && redacted.nested.ok === 1, JSON.stringify(redacted));

    // Generate a failing call, then confirm it was logged with its error code.
    await req(base, 'PATCH', '/v1/leads/00000000-0000-0000-0000-000000000000', { firstName: 'x' }, adminAuthA);
    await new Promise(r => setTimeout(r, 400));   // logging is fire-and-forget
    const apiLogRows = await withTenantHelper(tenantAResp.json.id,
      `SELECT method, path, status_code, error_code, request_body FROM api_request_log
       WHERE status_code >= 400 ORDER BY id DESC LIMIT 5`);
    assert('failed API calls are logged with method/path/status',
      apiLogRows.length >= 1 && apiLogRows[0].status_code >= 400 && !!apiLogRows[0].path, JSON.stringify(apiLogRows[0]));
    const pwLogRows = await withTenantHelper(tenantAResp.json.id,
      `SELECT request_body FROM api_request_log WHERE path LIKE '%change-password%' ORDER BY id DESC LIMIT 3`);
    assert('logged request bodies never contain plaintext passwords',
      pwLogRows.every((r: any) => !r.request_body || !/SalesPw|AdminPw|GenNewPw/.test(r.request_body)),
      JSON.stringify(pwLogRows));

    // ---- Retention purge actually deletes ----
    await withTenantHelper(tenantAResp.json.id,
      `INSERT INTO api_request_log (tenant_id, method, path, status_code, created_at)
       VALUES ($1,'GET','/v1/old',200, now() - INTERVAL '60 days')`, [tenantAResp.json.id]);
    const purged = await purgeTenant(tenantAResp.json.id, { ...resolveRetention({}), apiLogDays: 7 });
    assert('retention purge deletes aged rows', (purged.apiLogs || 0) >= 1, JSON.stringify(purged));
    const sweep = await runRetentionSweep();
    assert('retention sweep runs across all tenants without error', sweep.tenants >= 2, JSON.stringify({ tenants: sweep.tenants }));

    // ---- Payments ----
    const payLocked = await req(base, 'POST', '/v1/payments/connectors', { name: 'RP', provider: 'razorpay' }, adminAuthA);
    assert('payments is a paid feature, locked by default', payLocked.status === 402, JSON.stringify(payLocked.json));
    await req(base, 'PUT', `/host/api/tenants/${tenantAResp.json.id}/entitlements/payments`, { isEnabled: true }, hostAuth);

    const payProviders = await req(base, 'GET', '/v1/payments/providers', undefined, adminAuthA);
    assert('payment provider catalogue is exposed',
      payProviders.status === 200 && payProviders.json.items.some((p: any) => p.key === 'razorpay'), JSON.stringify(payProviders.json.items?.map((p: any) => p.key)));

    // A "static link" custom provider is fully testable offline — no external call needed.
    const payConn = await req(base, 'POST', '/v1/payments/connectors', {
      name: 'Static Pay', provider: 'custom',
      config: { mode: 'static', url: 'https://pay.example.com/checkout?amt={{amount}}&ref={{reference}}&who={{lead.email}}', webhookToken: 'wh-secret-1' },
      secrets: { token: 'tok-abc-123' },
    }, adminAuthA);
    assert('create a payment connector with the tenant\'s own credentials', payConn.status === 201, JSON.stringify(payConn.json));
    assert('payment connector response never leaks the secret',
      !JSON.stringify(payConn.json).includes('tok-abc-123'), JSON.stringify(payConn.json));
    const payCreds = await req(base, 'GET', `/v1/payments/connectors/${payConn.json.id}/credentials`, undefined, adminAuthA);
    assert('payment credentials are only ever shown masked',
      payCreds.json.masked.token && !payCreds.json.masked.token.includes('abc'), JSON.stringify(payCreds.json));

    const payLink = await req(base, 'POST', '/v1/payments/links', {
      connectorId: payConn.json.id, leadId, amount: 4999, currency: 'INR', description: 'Course fee',
    }, adminAuthA);
    assert('create a payment link from a lead',
      payLink.status === 201 && payLink.json.url?.includes('pay.example.com') && payLink.json.reference, JSON.stringify(payLink.json));
    assert('payment link URL is merged with amount + lead context',
      payLink.json.url.includes('4999') && payLink.json.url.includes('ravi%40example.com') === false && payLink.json.url.includes('ravi@example.com'),
      payLink.json.url);

    const payBadAmount = await req(base, 'POST', '/v1/payments/links', { connectorId: payConn.json.id, leadId, amount: 0 }, adminAuthA);
    assert('non-positive payment amount rejected', payBadAmount.status === 400, JSON.stringify(payBadAmount.json));

    // Send the link through a messaging template — "email/WhatsApp the bill" in one call.
    const payTpl = await req(base, 'POST', '/v1/messaging/templates', {
      name: 'Bill SMS', channel: 'sms',
      body: 'Hi {{lead.first_name}}, pay {{payment.currency}} {{payment.amount}} here: {{payment.url}}',
    }, adminAuthA);
    const payWithSend = await req(base, 'POST', '/v1/payments/links', {
      connectorId: payConn.json.id, leadId, amount: 1500, sendVia: 'sms', templateId: payTpl.json.id,
    }, adminAuthA);
    assert('a payment link can be sent via the messaging connector in one call',
      payWithSend.status === 201 && payWithSend.json.send !== null, JSON.stringify(payWithSend.json.send));
    const billMsgLog = await req(base, 'GET', `/v1/messaging/log?leadId=${leadId}`, undefined, adminAuthA);
    assert('the billing message body has the payment link merged in (no raw tokens)',
      billMsgLog.json.items.length >= 1 && !JSON.stringify(billMsgLog.json.items).includes('{{payment.url}}'),
      JSON.stringify(billMsgLog.json.items?.[0]));

    // ---- Payment webhook: unknown, unverified, then verified ----
    const whUnknown = await req(base, 'POST', '/payments/webhook/pl_doesnotexist', { event: 'paid' });
    assert('webhook for an unknown reference is ignored (not retried forever)',
      whUnknown.status === 200 && whUnknown.json.status === 'ignored', JSON.stringify(whUnknown.json));
    const whNoToken = await req(base, 'POST', `/payments/webhook/${payLink.json.reference}`, { event: 'paid' });
    assert('webhook without a valid token is rejected',
      whNoToken.status === 401 && whNoToken.json.error?.code === 'INVALID_SIGNATURE', JSON.stringify(whNoToken.json));
    const whOk = await req(base, 'POST', `/payments/webhook/${payLink.json.reference}?token=wh-secret-1`,
      { event: 'payment_link.paid', status: 'paid', amount: 499900 });
    assert('verified webhook marks the link paid', whOk.status === 200, JSON.stringify(whOk.json));

    const linksAfter = await req(base, 'GET', `/v1/payments/links?leadId=${leadId}`, undefined, adminAuthA);
    const paidRow = linksAfter.json.items.find((l: any) => l.reference === payLink.json.reference);
    assert('payment status and paid amount are recorded',
      paidRow?.status === 'paid' && Number(paidRow?.paid_amount) === 4999, JSON.stringify(paidRow));

    const leadActs = await req(base, 'GET', `/v1/leads/${leadId}/activities`, undefined, adminAuthA);
    assert('a payment logs an activity on the record timeline',
      leadActs.json.items.some((a: any) => String(a.note || '').includes('Payment received')),
      JSON.stringify(leadActs.json.items?.slice(0, 3).map((a: any) => a.note)));

    // Redelivery is normal for webhooks — it must not double-post.
    const actCountBefore = leadActs.json.items.filter((a: any) => String(a.note || '').includes('Payment received')).length;
    await req(base, 'POST', `/payments/webhook/${payLink.json.reference}?token=wh-secret-1`,
      { event: 'payment_link.paid', status: 'paid', amount: 499900 });
    const leadActs2 = await req(base, 'GET', `/v1/leads/${leadId}/activities`, undefined, adminAuthA);
    const actCountAfter = leadActs2.json.items.filter((a: any) => String(a.note || '').includes('Payment received')).length;
    assert('webhook redelivery is idempotent (no duplicate payment activity)',
      actCountAfter === actCountBefore, `${actCountBefore} -> ${actCountAfter}`);

    // =========================================================================================
    // Batch 7: forgot password, admin users/teams/permissions, WhatsApp own-device,
    // cost/revenue ledger, IP allowlist, data export, upsell signals, demo data.
    // =========================================================================================

    // ---- Forgot password (tenant): must not leak whether an account exists ----
    const fpKnown = await req(base, 'POST', '/auth/forgot-password', { tenantCode: tenantACode, email: 'admin@acme.local' });
    const fpUnknown = await req(base, 'POST', '/auth/forgot-password', { tenantCode: tenantACode, email: 'nobody@nowhere.local' });
    const fpBadTenant = await req(base, 'POST', '/auth/forgot-password', { tenantCode: 'no-such-tenant', email: 'x@y.com' });
    assert('forgot-password gives an identical response for known and unknown accounts',
      fpKnown.status === 200 && fpUnknown.status === 200 &&
      JSON.stringify(fpKnown.json) === JSON.stringify(fpUnknown.json), JSON.stringify({ known: fpKnown.json, unknown: fpUnknown.json }));
    assert('forgot-password does not leak whether a tenant exists', fpBadTenant.status === 200, JSON.stringify(fpBadTenant.json));
    assert('forgot-password never returns the reset link to an anonymous caller',
      !JSON.stringify(fpKnown.json).includes('token'), JSON.stringify(fpKnown.json));
    const fpMissing = await req(base, 'POST', '/auth/forgot-password', { email: 'x@y.com' });
    assert('forgot-password validates its inputs', fpMissing.status === 400, JSON.stringify(fpMissing.json));

    // A reset token generated by the flow must actually work end-to-end.
    const fpRows = await withTenantHelper(tenantAResp.json.id,
      `SELECT COUNT(*)::int AS n FROM password_resets WHERE used_at IS NULL AND expires_at > now()`);
    assert('forgot-password created a usable reset token', fpRows[0].n >= 1, JSON.stringify(fpRows[0]));

    // Anti-spam throttle: repeated requests stop issuing new tokens.
    const adminUserId = (await withTenantHelper(tenantAResp.json.id,
      `SELECT id FROM users WHERE lower(email)='admin@acme.local'`))[0].id;
    for (let i = 0; i < 5; i++) await req(base, 'POST', '/auth/forgot-password', { tenantCode: tenantACode, email: 'admin@acme.local' });
    // Scoped to THIS user: other tests legitimately create reset tokens for other users.
    const fpAfterSpam = await withTenantHelper(tenantAResp.json.id,
      `SELECT COUNT(*)::int AS n FROM password_resets
       WHERE user_id=$1 AND created_at > now() - INTERVAL '15 minutes'`, [adminUserId]);
    assert('forgot-password is throttled per account (max 3 per 15 min)',
      fpAfterSpam[0].n <= 3, `${fpAfterSpam[0].n} tokens issued for this account`);

    // ---- Host admin forgot password ----
    const hfp = await req(base, 'POST', '/host/auth/forgot-password', { email: 'e2e-owner@test.local' });
    const hfpUnknown = await req(base, 'POST', '/host/auth/forgot-password', { email: 'ghost@nowhere.local' });
    assert('host forgot-password is also non-enumerable',
      hfp.status === 200 && JSON.stringify(hfp.json) === JSON.stringify(hfpUnknown.json), JSON.stringify(hfp.json));
    const hostResetRows = await controlHelper(
      `SELECT token_hash FROM host_password_resets WHERE used_at IS NULL ORDER BY created_at DESC LIMIT 1`);
    assert('host reset token is stored hashed, never in plaintext',
      hostResetRows.length === 1 && /^[0-9a-f]{64}$/.test(hostResetRows[0].token_hash), JSON.stringify(hostResetRows[0]));
    const hostResetWeak = await req(base, 'POST', '/host/auth/reset-password', { token: 'x', newPassword: 'short' });
    assert('host password reset enforces a minimum length', hostResetWeak.status === 400, JSON.stringify(hostResetWeak.json));

    // ---- Admin users, teams, permissions ----
    const hostMe = await req(base, 'GET', '/host/api/team/me', undefined, hostAuth);
    assert('admin sees their own effective permissions',
      hostMe.status === 200 && hostMe.json.isSuperAdmin === true && hostMe.json.permissions.manageHostUsers === true,
      JSON.stringify({ super: hostMe.json?.isSuperAdmin, perms: Object.keys(hostMe.json?.permissions || {}).length }));

    const teams = await req(base, 'GET', '/host/api/team/teams', undefined, hostAuth);
    assert('default admin teams are seeded (Sales/Tech/Support/Billing)',
      teams.status === 200 && ['Sales', 'Tech', 'Support', 'Billing'].every(n => teams.json.items.some((t: any) => t.name === n)),
      JSON.stringify(teams.json.items?.map((t: any) => t.name)));

    const salesAdmin = await req(base, 'POST', '/host/api/team/users', {
      email: 'sales-admin@test.local', name: 'Sales Admin', teamName: 'Sales', role: 'support',
    }, hostAuth);
    assert('invite an admin user onto a team', salesAdmin.status === 201, JSON.stringify(salesAdmin.json));
    // The point is that no plaintext credential is ever handed out — only a one-time link.
    assert('invited admin gets a one-time link, never a plaintext password',
      !!salesAdmin.json.inviteUrl && salesAdmin.json.inviteUrl.includes('token=') &&
      !salesAdmin.json.tempPassword && !salesAdmin.json.user?.password_hash,
      JSON.stringify({ hasLink: !!salesAdmin.json.inviteUrl, hasTempPw: !!salesAdmin.json.tempPassword }));

    // The Sales team must NOT be able to change technical limits — that's the whole point.
    const salesInvite = new URL(salesAdmin.json.inviteUrl).searchParams.get('token')!;
    await req(base, 'POST', '/host/auth/reset-password', { token: salesInvite, newPassword: 'SalesAdminPw123!' });
    const salesLoginH = await req(base, 'POST', '/host/auth/login', { email: 'sales-admin@test.local', password: 'SalesAdminPw123!' });
    assert('invited admin can log in after setting their password', salesLoginH.status === 200 && salesLoginH.json.token, JSON.stringify(salesLoginH.json));
    const salesHostAuth = { authorization: `Bearer ${salesLoginH.json.token}` };

    const salesMe = await req(base, 'GET', '/host/api/team/me', undefined, salesHostAuth);
    assert('team permissions are inherited by members',
      salesMe.json.permissions.viewBilling === true && salesMe.json.permissions.manageLimits === false,
      JSON.stringify(salesMe.json.permissions));
    const salesTriesLimits = await req(base, 'GET', '/host/api/ledger/cost-model', undefined, salesHostAuth);
    assert('a Sales admin CAN see billing (their team grants it)', salesTriesLimits.status === 200, JSON.stringify(salesTriesLimits.json));
    const salesTriesUsers = await req(base, 'GET', '/host/api/team/users', undefined, salesHostAuth);
    assert('a Sales admin CANNOT manage admin users', salesTriesUsers.status === 403, JSON.stringify(salesTriesUsers.json));
    const salesTriesSuper = await req(base, 'POST', '/host/api/team/users', { email: 'x@y.com', name: 'X', isSuperAdmin: true }, salesHostAuth);
    assert('a non-super-admin cannot create a super admin', salesTriesSuper.status === 403, JSON.stringify(salesTriesSuper.json));

    assert('hostCan grants everything to a super admin', hostCan({ is_super_admin: true }, 'manageBilling') === true);
    assert('hostCan denies un-granted permissions', hostCan({ role: 'support', permissions: {}, team_permissions: {} }, 'manageBilling') === false);

    // ---- Admin action audit ----
    const hostAuditLog = await req(base, 'GET', '/host/api/team/audit', undefined, hostAuth);
    assert('admin panel actions are audited with the actor',
      hostAuditLog.status === 200 && hostAuditLog.json.items.some((a: any) => a.action === 'host_user.invited' && a.actor_email),
      JSON.stringify(hostAuditLog.json.items?.[0]));

    // ---- WhatsApp own-device mode (zero cost) ----
    const waPrep = await req(base, 'POST', '/v1/messaging/whatsapp/prepare', {
      leadId, body: 'Hi {{lead.first_name}}, your quote for {{lead.fields.mx_city_tier}} is ready.',
    }, adminAuthA);
    assert('own-device WhatsApp returns a wa.me deep link',
      waPrep.status === 200 && waPrep.json.url.startsWith('https://wa.me/') && waPrep.json.appUrl.startsWith('whatsapp://'),
      JSON.stringify({ url: waPrep.json?.url?.slice(0, 60) }));
    assert('the deep link carries the digits-only number and merged text',
      waPrep.json.to === '919876543210' && waPrep.json.text.includes('Ravi') && !waPrep.json.text.includes('{{'),
      JSON.stringify({ to: waPrep.json?.to, text: waPrep.json?.text }));
    const waTplPrep = await req(base, 'POST', '/v1/messaging/whatsapp/prepare', { leadId, templateId: tpl.json.id }, adminAuthA);
    assert('own-device WhatsApp can use a saved template', waTplPrep.status === 200 && waTplPrep.json.text.length > 0, JSON.stringify(waTplPrep.json?.text));
    const waNoPhone = await req(base, 'POST', '/v1/messaging/whatsapp/prepare', { leadId: leadU1.json.lead.id, body: 'hi' }, adminAuthA);
    assert('own-device WhatsApp errors clearly when the lead has no phone',
      waNoPhone.status === 400 && waNoPhone.json.error?.code === 'NO_RECIPIENT', JSON.stringify(waNoPhone.json));
    const waLog = await req(base, 'GET', `/v1/messaging/log?leadId=${leadId}`, undefined, adminAuthA);
    assert('own-device sends are logged as "prepared" (we cannot confirm delivery)',
      waLog.json.items.some((m: any) => m.status === 'prepared'), JSON.stringify(waLog.json.items?.map((m: any) => m.status).slice(0, 5)));

    // ---- IP allowlist ----
    assert('CIDR matching works for in-range addresses',
      ipInCidr('203.0.113.5', '203.0.113.0/24') === true && ipInCidr('10.1.2.3', '10.0.0.0/8') === true);
    assert('CIDR matching rejects out-of-range addresses',
      ipInCidr('203.0.114.5', '203.0.113.0/24') === false && ipInCidr('11.1.2.3', '10.0.0.0/8') === false);
    assert('exact IP matching works without a mask',
      ipInCidr('1.2.3.4', '1.2.3.4') === true && ipInCidr('1.2.3.5', '1.2.3.4') === false);
    const ipEmpty = await req(base, 'PUT', `/host/api/tenants/${tenantBResp.json.id}/ip-allowlist`, { enabled: true, allowlist: [] }, hostAuth);
    assert('enabling an empty allowlist is refused (would lock the tenant out)',
      ipEmpty.status === 400 && ipEmpty.json.error?.code === 'EMPTY_ALLOWLIST', JSON.stringify(ipEmpty.json));
    const ipBad = await req(base, 'PUT', `/host/api/tenants/${tenantBResp.json.id}/ip-allowlist`, { enabled: true, allowlist: ['999.1.1.1'] }, hostAuth);
    assert('invalid IP entries are rejected', ipBad.status === 400, JSON.stringify(ipBad.json));
    const ipOk = await req(base, 'PUT', `/host/api/tenants/${tenantBResp.json.id}/ip-allowlist`,
      { enabled: false, allowlist: ['203.0.113.0/24', '198.51.100.7'] }, hostAuth);
    assert('a valid allowlist can be stored (disabled)', ipOk.status === 200 && ipOk.json.allowlist.length === 2, JSON.stringify(ipOk.json));

    // ---- Cost / revenue ledger ----
    const cm = await req(base, 'PATCH', '/host/api/ledger/cost-model', {
      fixedMonthlyInfra: 8000, costPerGbStorage: 25, costPerMillionApiCalls: 40, costPer1kMessages: 15,
    }, hostAuth);
    assert('cost model is editable', cm.status === 200 && Number(cm.json.fixed_monthly_infra) === 8000, JSON.stringify(cm.json));

    const revEntry = await req(base, 'POST', `/host/api/ledger/tenants/${tenantAResp.json.id}/entries`, {
      entryType: 'revenue', category: 'subscription', amount: 25000, description: 'Aug subscription, 10 users', isPaid: true,
    }, hostAuth);
    assert('record revenue against a customer', revEntry.status === 201, JSON.stringify(revEntry.json));
    const unpaidEntry = await req(base, 'POST', `/host/api/ledger/tenants/${tenantAResp.json.id}/entries`, {
      entryType: 'revenue', category: 'subscription', amount: 25000, description: 'Sep subscription (invoice sent)', isPaid: false,
    }, hostAuth);
    assert('record outstanding (unpaid) revenue', unpaidEntry.status === 201 && unpaidEntry.json.is_paid === false, JSON.stringify(unpaidEntry.json));
    const costEntry = await req(base, 'POST', `/host/api/ledger/tenants/${tenantAResp.json.id}/entries`, {
      entryType: 'cost', category: 'support', amount: 3000, description: 'Onboarding support time',
    }, hostAuth);
    assert('record a cost against a customer', costEntry.status === 201, JSON.stringify(costEntry.json));
    const badCat = await req(base, 'POST', `/host/api/ledger/tenants/${tenantAResp.json.id}/entries`,
      { entryType: 'cost', category: 'nonsense', amount: 1 }, hostAuth);
    assert('invalid ledger category rejected', badCat.status === 400, JSON.stringify(badCat.json));

    const usageA = await req(base, 'GET', `/host/api/ledger/tenants/${tenantAResp.json.id}/usage`, undefined, hostAuth);
    assert('measured per-tenant usage is reported',
      usageA.status === 200 && usageA.json.leads >= 0 && 'estimatedGb' in usageA.json && 'apiCalls30d' in usageA.json,
      JSON.stringify({ leads: usageA.json?.leads, gb: usageA.json?.estimatedGb }));

    const autoCost = await req(base, 'POST', `/host/api/ledger/tenants/${tenantAResp.json.id}/auto-cost`, {}, hostAuth);
    assert('auto-derived cost is computed from usage + cost model',
      autoCost.status === 201 && autoCost.json.breakdown.total > 0 && autoCost.json.entry.source === 'auto',
      JSON.stringify(autoCost.json.breakdown));
    // Re-running must not double-count the same period.
    const autoCost2 = await req(base, 'POST', `/host/api/ledger/tenants/${tenantAResp.json.id}/auto-cost`, {}, hostAuth);
    const autoRows = await controlHelper(
      `SELECT COUNT(*)::int AS n FROM tenant_ledger WHERE tenant_id=$1 AND source='auto'`, [tenantAResp.json.id]);
    assert('re-running auto-cost replaces rather than duplicates the period',
      autoCost2.status === 201 && autoRows[0].n === 1, `${autoRows[0].n} auto rows`);

    const profit = await req(base, 'GET', '/host/api/ledger/profitability', undefined, hostAuth);
    const tenantAProfit = profit.json.items.find((i: any) => i.id === tenantAResp.json.id);
    assert('profitability report computes per-tenant P&L',
      profit.status === 200 && tenantAProfit && tenantAProfit.revenue_received === 25000 && tenantAProfit.total_cost > 0,
      JSON.stringify(tenantAProfit));
    assert('outstanding (unpaid) revenue is tracked separately from received',
      tenantAProfit.revenue_outstanding === 25000, JSON.stringify({ received: tenantAProfit?.revenue_received, outstanding: tenantAProfit?.revenue_outstanding }));
    assert('margin percent and loss flag are computed',
      typeof tenantAProfit.marginPercent === 'number' && typeof tenantAProfit.isLossMaking === 'boolean', JSON.stringify(tenantAProfit));
    assert('overall roll-up is provided across all customers',
      profit.json.overall.tenantCount >= 2 && 'profit' in profit.json.overall && 'lossMakingTenants' in profit.json.overall,
      JSON.stringify(profit.json.overall));

    // Sales team can view billing but a Support-only admin must not manage it.
    const salesLedger = await req(base, 'POST', `/host/api/ledger/tenants/${tenantAResp.json.id}/entries`,
      { entryType: 'revenue', category: 'subscription', amount: 1 }, salesHostAuth);
    assert('Sales team CAN record billing entries (manageBilling granted)', salesLedger.status === 201, JSON.stringify(salesLedger.json));

    // ---- Upsell signals ----
    const upsell = await req(base, 'GET', '/host/api/ledger/upsell-signals', undefined, hostAuth);
    assert('upsell signals are derived from real usage data',
      upsell.status === 200 && Array.isArray(upsell.json.items) &&
      upsell.json.items.every((i: any) => Array.isArray(i.reasons) && i.priority), JSON.stringify(upsell.json.items?.slice(0, 2)));

    // ---- Data export ----
    const expSummary = await req(base, 'GET', '/v1/export/summary', undefined, adminAuthA);
    assert('export summary reports row counts before downloading',
      expSummary.status === 200 && expSummary.json.sections.leads >= 1 && expSummary.json.total > 0,
      JSON.stringify({ leads: expSummary.json?.sections?.leads, total: expSummary.json?.total }));
    const expDenied = await req(base, 'GET', '/v1/export/summary', undefined, salesAuthFresh);
    assert('non-admins cannot export all tenant data', expDenied.status === 403, JSON.stringify(expDenied.json));

    const expResp = await fetch(`${base}/v1/export/full`, { headers: { authorization: adminAuthA.authorization } });
    const expText = await expResp.text();
    const expLines = expText.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } });
    assert('full export streams valid NDJSON', expResp.status === 200 && expLines.every(l => l !== null), `${expLines.length} lines`);
    assert('export begins with a metadata header and ends with counts',
      expLines[0]?._meta === 'nexcrm-export' && expLines[expLines.length - 1]?._meta === 'end',
      JSON.stringify({ first: expLines[0]?._meta, last: expLines[expLines.length - 1]?._meta }));
    assert('export contains the tenant\'s leads', expLines.some(l => l?._t === 'leads'), 'no lead rows found');
    assert('export deliberately excludes connector credentials',
      !expLines.some(l => l?._t === 'connectors') && !expText.includes('secrets_encrypted'), 'credentials leaked into export');

    // ---- Demo data generator ----
    const demoTenant = await req(base, 'POST', '/host/api/tenants', {
      name: 'Demo Co', subdomain: 'demo-e2e', isTest: true, planCode: 'pro', template: 'education',
      adminEmail: 'admin@demo.local', adminPassword: 'DemoPw123!',
    }, hostAuth);
    const demoGen = await req(base, 'POST', `/host/api/tenants/${demoTenant.json.id}/demo-data`,
      { leadCount: 60, days: 60, seed: 7 }, hostAuth);
    assert('demo data generator creates a believable dataset',
      demoGen.status === 201 && demoGen.json.generated.leads > 20 && demoGen.json.generated.activities > 0,
      JSON.stringify(demoGen.json.generated));
    const demoLogin = await req(base, 'POST', '/auth/login', { tenantCode: demoTenant.json.code, email: 'admin@demo.local', password: 'DemoPw123!' });
    const demoAuth = { authorization: `Bearer ${demoLogin.json.token}` };
    const demoReports = await req(base, 'GET', '/v1/reports/overview?coldDays=7', undefined, demoAuth);
    assert('demo data makes the dashboard look alive (funnel + trend populated)',
      demoReports.status === 200 && demoReports.json.totals.total > 20 &&
      demoReports.json.byStage.some((s: any) => s.count > 0) && demoReports.json.trend.length === 14,
      JSON.stringify({ total: demoReports.json?.totals?.total, stages: demoReports.json?.byStage?.length }));
    assert('demo data includes cold leads so "Needs Attention" demos well',
      Array.isArray(demoReports.json.cold), JSON.stringify({ cold: demoReports.json?.cold?.length }));
    const demoBad = await req(base, 'POST', `/host/api/tenants/${demoTenant.json.id}/demo-data`, { leadCount: 99999 }, hostAuth);
    assert('demo data generator caps the row count', demoBad.status === 400, JSON.stringify(demoBad.json));

    // =========================================================================================
    // Batch 8: two-mechanism password reset, hierarchy resets, refunds/partial payments,
    // structured logging, SEO hygiene.
    // =========================================================================================

    // ---- MECHANISM 1: internal reset is the DEFAULT (no email provider needed) ----
    const settingsB = await req(base, 'GET', '/v1/settings/tenant', undefined, adminAuthB);
    assert('password reset defaults to internal (no email provider required to buy)',
      settingsB.json.passwordResetMode === 'internal' && settingsB.json.allowManagerPasswordReset === true,
      JSON.stringify({ mode: settingsB.json?.passwordResetMode }));

    // In internal mode, the public forgot-password endpoint must not pretend to send email.
    const fpInternal = await req(base, 'POST', '/auth/forgot-password', { tenantCode: tenantBCode, email: 'rep1@beta.local' });
    assert('internal mode tells the user to contact their admin/manager instead of silently doing nothing',
      fpInternal.status === 200 && /administrator|manager/i.test(fpInternal.json.hint || ''), JSON.stringify(fpInternal.json));

    // An admin can reset anyone and gets BOTH a link and a temp password to pass on.
    const adminReset = await req(base, 'POST', `/v1/users/${rep1.json.id}/reset-link`, {}, adminAuthB);
    assert('a tenant admin can reset any user\'s password',
      adminReset.status === 201 && adminReset.json.resetUrl && adminReset.json.tempPassword && adminReset.json.via === 'admin',
      JSON.stringify({ via: adminReset.json?.via, hasBoth: !!(adminReset.json?.resetUrl && adminReset.json?.tempPassword) }));
    // The temp password must actually work, and force a change at next login.
    const loginTemp = await req(base, 'POST', '/auth/login',
      { tenantCode: tenantBCode, email: 'rep1@beta.local', password: adminReset.json.tempPassword });
    assert('the admin-issued temporary password works and forces a change',
      loginTemp.status === 200 && loginTemp.json.mustChangePassword === true, JSON.stringify(loginTemp.json));

    // A MANAGER can reset for their own report — the case that removes the email dependency.
    const mgrReset = await req(base, 'POST', `/v1/users/${rep1.json.id}/reset-link`, {}, managerAuth);
    assert('a manager can reset the password of someone who reports to them',
      mgrReset.status === 201 && mgrReset.json.via === 'manager', JSON.stringify({ status: mgrReset.status, via: mgrReset.json?.via }));

    // ...but NOT for someone outside their hierarchy.
    const mgrResetOutsider = await req(base, 'POST', `/v1/users/${rep2.json.id}/reset-link`, {}, managerAuth);
    assert('a manager cannot reset passwords outside their hierarchy',
      mgrResetOutsider.status === 403, JSON.stringify(mgrResetOutsider.json));

    // Turning the manager capability off restricts it to admins only.
    await req(base, 'PATCH', '/v1/settings/tenant', { allowManagerPasswordReset: false }, adminAuthB);
    const mgrResetDisabled = await req(base, 'POST', `/v1/users/${rep1.json.id}/reset-link`, {}, managerAuth);
    assert('manager password reset can be disabled per tenant',
      mgrResetDisabled.status === 403 && /administrator/i.test(mgrResetDisabled.json.error?.message || ''),
      JSON.stringify(mgrResetDisabled.json));
    await req(base, 'PATCH', '/v1/settings/tenant', { allowManagerPasswordReset: true }, adminAuthB);

    const resettable = await req(base, 'GET', '/v1/users/resettable', undefined, managerAuth);
    assert('the UI can discover who a manager may reset',
      resettable.status === 200 && resettable.json.mode === 'manager' && resettable.json.userIds.includes(rep1.json.id),
      JSON.stringify({ mode: resettable.json?.mode, n: resettable.json?.userIds?.length }));

    // Password resets are audited (who reset whom, and via which route).
    const resetAudit = await req(base, 'GET', '/v1/audit?entity=user', undefined, adminAuthB);
    assert('password resets are audited with the route used',
      resetAudit.json.items.some((a: any) => a.action === 'user.password_reset'),
      JSON.stringify(resetAudit.json.items?.map((a: any) => a.action).slice(0, 5)));

    // ---- MECHANISM 2: email mode requires a real connector first ----
    const emailModeNoConn = await req(base, 'PATCH', '/v1/settings/tenant', { passwordResetMode: 'email' }, adminAuthB);
    assert('email-based reset cannot be enabled without an email connector',
      emailModeNoConn.status === 400 && emailModeNoConn.json.error?.code === 'NO_EMAIL_CONNECTOR',
      JSON.stringify(emailModeNoConn.json));

    // Tenant A has an email connector? Create one, then switching must succeed.
    await req(base, 'POST', '/v1/messaging/connectors', {
      name: 'Resend Email', provider: 'resend', channel: 'email',
      config: { fromEmail: 'noreply@acme.local', fromName: 'Acme' }, secrets: { apiKey: 'rs-test-key' },
    }, adminAuthA);
    const emailModeOn = await req(base, 'PATCH', '/v1/settings/tenant', { passwordResetMode: 'email' }, adminAuthA);
    assert('email-based reset can be enabled once a provider is connected',
      emailModeOn.status === 200 && emailModeOn.json.passwordResetMode === 'email', JSON.stringify(emailModeOn.json?.passwordResetMode));
    const fpEmailMode = await req(base, 'POST', '/auth/forgot-password', { tenantCode: tenantACode, email: 'admin@acme.local' });
    assert('in email mode the flow proceeds without the internal-mode hint',
      fpEmailMode.status === 200 && !fpEmailMode.json.hint, JSON.stringify(fpEmailMode.json));
    // One-button switch back — the escape hatch if their provider fails.
    const switchBack = await req(base, 'PATCH', '/v1/settings/tenant', { passwordResetMode: 'internal' }, adminAuthA);
    assert('a tenant can switch back to internal reset instantly',
      switchBack.status === 200 && switchBack.json.passwordResetMode === 'internal', JSON.stringify(switchBack.json?.passwordResetMode));
    const badMode2 = await req(base, 'PATCH', '/v1/settings/tenant', { passwordResetMode: 'telepathy' }, adminAuthA);
    assert('invalid password reset mode rejected', badMode2.status === 400, JSON.stringify(badMode2.json));

    // ---- Refunds and partial payments ----
    const partLink = await req(base, 'POST', '/v1/payments/links', {
      connectorId: payConn.json.id, leadId, amount: 10000, description: 'Installment plan',
    }, adminAuthA);
    assert('create a link for an installment plan', partLink.status === 201, JSON.stringify(partLink.json));

    // First installment: 4,000 of 10,000 -> partially paid.
    const inst1 = await req(base, 'POST', `/payments/webhook/${partLink.json.reference}?token=wh-secret-1`,
      { event: 'payment.captured', status: 'paid', amount: 400000, id: 'evt_inst_1' });
    assert('a part payment is accepted', inst1.status === 200, JSON.stringify(inst1.json));
    let partState = await req(base, 'GET', `/v1/payments/links/${partLink.json.id}/events`, undefined, adminAuthA);
    assert('a part payment sets status partially_paid and computes the remaining balance',
      partState.json.link.status === 'partially_paid' && partState.json.amountDue === 6000 && partState.json.isFullyPaid === false,
      JSON.stringify({ status: partState.json?.link?.status, due: partState.json?.amountDue }));

    // Redelivery of the SAME event must be ignored, but a NEW installment must apply.
    await req(base, 'POST', `/payments/webhook/${partLink.json.reference}?token=wh-secret-1`,
      { event: 'payment.captured', status: 'paid', amount: 400000, id: 'evt_inst_1' });
    partState = await req(base, 'GET', `/v1/payments/links/${partLink.json.id}/events`, undefined, adminAuthA);
    assert('redelivering the same installment does not double-count',
      partState.json.netPaid === 4000 && partState.json.events.length === 1,
      JSON.stringify({ net: partState.json?.netPaid, events: partState.json?.events?.length }));

    await req(base, 'POST', `/payments/webhook/${partLink.json.reference}?token=wh-secret-1`,
      { event: 'payment.captured', status: 'paid', amount: 600000, id: 'evt_inst_2' });
    partState = await req(base, 'GET', `/v1/payments/links/${partLink.json.id}/events`, undefined, adminAuthA);
    assert('a second installment completes the payment',
      partState.json.link.status === 'paid' && partState.json.netPaid === 10000 && partState.json.isFullyPaid === true,
      JSON.stringify({ status: partState.json?.link?.status, net: partState.json?.netPaid }));

    // Provider-initiated partial refund.
    await req(base, 'POST', `/payments/webhook/${partLink.json.reference}?token=wh-secret-1`,
      { event: 'refund.processed', amount: 250000, id: 'evt_refund_1' });
    partState = await req(base, 'GET', `/v1/payments/links/${partLink.json.id}/events`, undefined, adminAuthA);
    assert('a partial refund is recorded and reduces the net paid',
      partState.json.link.status === 'partially_refunded' && partState.json.netPaid === 7500,
      JSON.stringify({ status: partState.json?.link?.status, net: partState.json?.netPaid }));

    // Manually recorded refund (someone refunded in the provider's own dashboard).
    const manualRefund = await req(base, 'POST', `/v1/payments/links/${partLink.json.id}/record-refund`,
      { amount: 7500, note: 'Refunded in Razorpay dashboard' }, adminAuthA);
    assert('a refund made outside the CRM can be recorded so numbers stay correct',
      manualRefund.status === 200 && manualRefund.json.status === 'refunded' && manualRefund.json.netPaid === 0,
      JSON.stringify(manualRefund.json));
    const overRefund = await req(base, 'POST', `/v1/payments/links/${partLink.json.id}/record-refund`,
      { amount: 5000 }, adminAuthA);
    assert('refunding more than was paid is refused',
      overRefund.status === 400 && overRefund.json.error?.code === 'REFUND_EXCEEDS_PAID', JSON.stringify(overRefund.json));

    const refundActs = await req(base, 'GET', `/v1/leads/${leadId}/activities`, undefined, adminAuthA);
    assert('refunds and part payments appear on the record timeline',
      refundActs.json.items.some((a: any) => /Refund processed/i.test(a.note || '')) &&
      refundActs.json.items.some((a: any) => /Part payment received/i.test(a.note || '')),
      JSON.stringify(refundActs.json.items?.filter((a: any) => /payment|refund/i.test(a.note || '')).map((a: any) => a.note).slice(0, 3)));

    // ---- Structured logging + request ids ----
    const ridResp = await fetch(`${base}/v1/leads?limit=1`, { headers: { authorization: adminAuthA.authorization } });
    assert('every response carries a request id for support correlation',
      !!ridResp.headers.get('x-request-id'), String(ridResp.headers.get('x-request-id')));
    const echoResp = await fetch(`${base}/v1/leads?limit=1`, {
      headers: { authorization: adminAuthA.authorization, 'x-request-id': 'trace-abc-12345678' },
    });
    assert('an inbound request id is honoured so traces span hops',
      echoResp.headers.get('x-request-id') === 'trace-abc-12345678', String(echoResp.headers.get('x-request-id')));

    // ---- SEO hygiene: nothing the API serves should be indexed ----
    const robots = await fetch(`${base}/robots.txt`);
    const robotsText = await robots.text();
    assert('robots.txt disallows all crawling of the API',
      robots.status === 200 && /Disallow:\s*\//.test(robotsText), robotsText.trim());
    const formPageSeo = await fetch(`${base}/capture/v1/forms/${webform.json.public_token}/page`);
    assert('customer capture forms are noindex (they must not compete with the customer\'s own site)',
      (formPageSeo.headers.get('x-robots-tag') || '').includes('noindex'), String(formPageSeo.headers.get('x-robots-tag')));
    const docsSeo = await fetch(`${base}/docs`);
    assert('API docs are served but not indexed', docsSeo.status === 200 &&
      (docsSeo.headers.get('x-robots-tag') || '').includes('noindex'), String(docsSeo.headers.get('x-robots-tag')));

    // ---- SEAT LIMIT (plans.max_users) ----
    // Existed as a column and was sold against, but was never enforced: a 10-seat customer could
    // create 500 users. On per-user pricing that is silent lost revenue, so it is covered here.
    await control(c => c.query(
      `INSERT INTO plans (code, name, max_users, api_daily_quota, api_rate_per_sec, features)
       VALUES ('seat-e2e','Seat Test',2,5000000,10000,'{}') ON CONFLICT (code) DO NOTHING`));
    const seatTenant = await req(base, 'POST', '/host/api/tenants', {
      name: 'Seat Ltd', subdomain: 'seat-e2e', isTest: true, planCode: 'seat-e2e',
      adminEmail: 'admin@seat.local', adminPassword: 'AdminPw123!',
    }, hostAuth);
    assert('seat-limited tenant created', seatTenant.status === 201, JSON.stringify(seatTenant.json));
    const seatLogin = await req(base, 'POST', '/auth/login', {
      tenantCode: seatTenant.json.code, email: 'admin@seat.local', password: 'AdminPw123!' });
    const seatAuth = { authorization: `Bearer ${seatLogin.json.token}` };
    const seatRoles = await req(base, 'GET', '/v1/roles', undefined, seatAuth);
    const seatRoleId = seatRoles.json.items.find((r: any) => r.name === 'Sales User').id;
    const mkUser = (email: string) => req(base, 'POST', '/v1/users',
      { email, firstName: 'Seat', roleId: seatRoleId }, seatAuth);

    // Plan allows 2; the tenant admin already occupies seat 1.
    const seat2 = await mkUser('seat2@seat.local');
    assert('a user can be created while seats remain', seat2.status === 201, JSON.stringify(seat2.json));
    const seat3 = await mkUser('seat3@seat.local');
    assert('creating a user beyond the plan seat limit is refused',
      seat3.status === 402 && seat3.json.error?.code === 'PLAN_USER_LIMIT', JSON.stringify(seat3.json));

    // Freeing a seat must actually free it.
    const deact = await req(base, 'PATCH', `/v1/users/${seat2.json.id}`, { isActive: false }, seatAuth);
    assert('deactivating a user succeeds', deact.status === 200, JSON.stringify(deact.json));
    const seat3b = await mkUser('seat3b@seat.local');
    assert('a freed seat can be reused', seat3b.status === 201, JSON.stringify(seat3b.json));

    // Reactivation is the other way around the limit, and must be blocked too.
    const react = await req(base, 'PATCH', `/v1/users/${seat2.json.id}`, { isActive: true }, seatAuth);
    assert('reactivating a user beyond the seat limit is refused',
      react.status === 402 && react.json.error?.code === 'PLAN_USER_LIMIT', JSON.stringify(react.json));

    // An ordinary edit on an at-capacity tenant must still work.
    const rename = await req(base, 'PATCH', `/v1/users/${seat3b.json.id}`, { firstName: 'Renamed' }, seatAuth);
    assert('editing a user at capacity still works', rename.status === 200, JSON.stringify(rename.json));

  } finally {
    stopWebhookDispatcher();
    server.close();
    receiver.close();
    await stopDb();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED CHECKS:', failed.map(f => f.name).join(', '));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error('e2e fatal error', e); process.exit(1); });
