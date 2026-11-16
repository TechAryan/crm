/**
 * seed-demo — a full, clickable local environment.
 *
 * WHY THIS EXISTS, separate from `seed.ts`:
 *   `seed.ts` creates the bare minimum to boot: three plans, a host owner, one empty tenant.
 *   That is correct for a fresh production install — you do NOT want fake leads in a customer's
 *   database. But it is useless for actually looking at the product, because almost every screen
 *   worth reviewing (dashboard, funnel, trend charts, "needs attention", reports) renders blank
 *   without data, and each vertical template produces a *different* set of stages, custom fields
 *   and opportunity types. You cannot review "the UI" against one empty generic tenant.
 *
 * So this creates one tenant per vertical template, each populated with believable demo data,
 * and prints the credentials for all of them.
 *
 * SAFETY: refuses to run against a database that has any non-test tenant. Demo data in a real
 * customer's tenant would be unrecoverable without knowing which rows were fake, so the guard
 * is a hard stop rather than a prompt. Override deliberately with SEED_DEMO_FORCE=1.
 *
 *   npm run seed:demo                 # 250 leads per tenant
 *   LEADS=1000 npm run seed:demo      # heavier, for testing list performance
 */
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { initDb, stopDb, control } from '../src/db.js';
import { createTenant } from '../src/provisioning.js';
import { generateDemoData } from '../src/demoData.js';

const PASSWORD = 'Demo1234!';

/** One per template in templates.ts. `label` is what a human calls the vertical. */
const VERTICALS = [
  { template: 'agency',    subdomain: 'demo-agency',    name: 'Bright Reach Media',   label: 'Digital marketing agency', plan: 'pro' },
  { template: 'education',  subdomain: 'demo-education',  name: 'Vidya Academy',        label: 'Education / coaching',     plan: 'pro' },
  { template: 'ecommerce',  subdomain: 'demo-ecommerce',  name: 'Kanha Retail',         label: 'E-commerce',               plan: 'pro' },
  { template: 'astrology',  subdomain: 'demo-astrology',  name: 'Shubh Jyotish',        label: 'Astrology / spiritual',    plan: 'starter' },
  { template: 'creator',    subdomain: 'demo-creator',    name: 'Studio Nine',          label: 'Creator / YouTuber',       plan: 'starter' },
  { template: 'generic',    subdomain: 'demo-jewellery',  name: 'Ratna Jewellers',      label: 'Jewellery (generic base)', plan: 'enterprise' },
] as const;

const PLANS = [
  { code: 'starter',    name: 'Starter',    maxUsers: 10,   apiDailyQuota: 50000,   apiRatePerSec: 10, features: { whatsapp: true, meta: true, automation: false } },
  { code: 'pro',        name: 'Pro',        maxUsers: 50,   apiDailyQuota: 250000,  apiRatePerSec: 25, features: { whatsapp: true, meta: true, automation: true, webhooks: true } },
  { code: 'enterprise', name: 'Enterprise', maxUsers: 1000, apiDailyQuota: 1000000, apiRatePerSec: 50, features: { whatsapp: true, meta: true, automation: true, webhooks: true, whiteLabel: true } },
];

async function main() {
  const leadCount = parseInt(process.env.LEADS || '250', 10);
  await initDb();

  // --- guard: never touch a database that looks like it holds real customers ---
  // The guard names the tenants it found. An earlier version printed only a count, which was
  // useless in the common case: the e2e suite shares this embedded database and used to leave
  // its tenants marked as non-test, so the guard fired on every machine that had ever run a
  // push — reporting "5 non-test tenants" that were nothing but leftover test fixtures.
  const real = await control(c => c.query(
    `SELECT name, subdomain, created_at FROM tenants WHERE is_test = false ORDER BY created_at`));
  if (real.rowCount && process.env.SEED_DEMO_FORCE !== '1') {
    const dataDir = process.env.EMBEDDED_PG_DIR || path.join(os.tmpdir(), 'nexcrm-embedded-pgdata');
    console.error(`\n  REFUSING TO SEED: this database has ${real.rowCount} tenant(s) not marked as test data:\n`);
    for (const t of real.rows) console.error(`      ${String(t.subdomain).padEnd(24)} ${t.name}`);
    console.error(`\n  If these are leftovers from a test run, reset the local database and try again:`);
    console.error(`      rm -rf ${dataDir}`);
    console.error(`      npm run seed:demo`);
    console.error(`\n  If this is a real database, do not seed it. Override only if you are certain:`);
    console.error(`      SEED_DEMO_FORCE=1 npm run seed:demo\n`);
    await stopDb();
    process.exit(1);
  }

  for (const p of PLANS) {
    await control(c => c.query(
      `INSERT INTO plans (code, name, max_users, api_daily_quota, api_rate_per_sec, features)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, p.maxUsers, p.apiDailyQuota, p.apiRatePerSec, JSON.stringify(p.features)]));
  }
  console.log(`plans ready (${PLANS.map(p => p.code).join(', ')})`);

  // --- host/admin-panel owner ---
  // Hash once, up front: `control()` takes a NON-async callback, so awaiting inside it is a
  // type error (and would be a bug even if it compiled — the query would receive a Promise).
  const hash = await bcrypt.hash(PASSWORD, 10);
  const owner = await control(c => c.query(`SELECT id FROM host_users WHERE email='owner@nexcrm.local'`));
  if (owner.rowCount === 0) {
    await control(c => c.query(
      `INSERT INTO host_users (email, name, password_hash, role, is_super_admin) VALUES ($1,$2,$3,'owner',true)`,
      ['owner@nexcrm.local', 'Host Owner', hash]));
    console.log('host owner created');
  } else {
    // Re-runs reset the password, so a forgotten demo password is never a dead end.
    await control(c => c.query(`UPDATE host_users SET password_hash=$1, must_change_password=false WHERE email='owner@nexcrm.local'`,
      [hash]));
    console.log('host owner exists (password reset to demo password)');
  }

  const rows: { label: string; name: string; code: string; subdomain: string; email: string }[] = [];

  for (const v of VERTICALS) {
    const existing = await control(c => c.query(`SELECT id, code FROM tenants WHERE subdomain=$1`, [v.subdomain]));
    const adminEmail = `admin@${v.subdomain}.local`;

    if (existing.rowCount) {
      console.log(`  ${v.subdomain}: already exists, skipping`);
      rows.push({ label: v.label, name: v.name, code: existing.rows[0].code, subdomain: v.subdomain, email: adminEmail });
      continue;
    }

    process.stdout.write(`  ${v.subdomain}: creating (${v.template})… `);
    const tenant = await createTenant({
      name: v.name, subdomain: v.subdomain, planCode: v.plan, isTest: true, region: 'in',
      template: v.template, adminEmail, adminName: 'Demo Admin', adminPassword: PASSWORD,
    });
    // Different seed per vertical, so the six demo tenants don't look like copies of each other.
    await generateDemoData(tenant.id, { leadCount, days: 90, seed: v.subdomain.length * 7919 });
    console.log(`${leadCount} leads`);
    rows.push({ label: v.label, name: v.name, code: tenant.code, subdomain: v.subdomain, email: adminEmail });
  }

  const w = (s: string, n: number) => s.padEnd(n);
  console.log(`\n${'='.repeat(96)}`);
  console.log(`  ADMIN PANEL      http://localhost:5173/host/login`);
  console.log(`                   owner@nexcrm.local  /  ${PASSWORD}`);
  console.log(`\n  CRM LOGIN        http://localhost:5173/login   (all six use password: ${PASSWORD})`);
  console.log(`  ${'-'.repeat(92)}`);
  console.log(`  ${w('Vertical', 26)}${w('Tenant code', 14)}${w('or subdomain', 18)}Email`);
  console.log(`  ${'-'.repeat(92)}`);
  for (const r of rows) console.log(`  ${w(r.label, 26)}${w(r.code, 14)}${w(r.subdomain, 18)}${r.email}`);
  console.log(`${'='.repeat(96)}`);
  console.log(`  The login form's first field accepts EITHER the tenant code or the subdomain.\n`);

  await stopDb();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
