import bcrypt from 'bcryptjs';
import { initDb, stopDb, control } from '../src/db.js';
import { createTenant } from '../src/provisioning.js';

async function seed() {
  await initDb();

  // Plans
  const plans = [
    { code: 'starter', name: 'Starter', maxUsers: 10, apiDailyQuota: 50000, apiRatePerSec: 10, features: { whatsapp: true, meta: true, automation: false } },
    { code: 'pro', name: 'Pro', maxUsers: 50, apiDailyQuota: 250000, apiRatePerSec: 25, features: { whatsapp: true, meta: true, automation: true, webhooks: true } },
    { code: 'enterprise', name: 'Enterprise', maxUsers: 1000, apiDailyQuota: 1000000, apiRatePerSec: 50, features: { whatsapp: true, meta: true, automation: true, webhooks: true, whiteLabel: true } },
  ];
  for (const p of plans) {
    await control(c => c.query(
      `INSERT INTO plans (code, name, max_users, api_daily_quota, api_rate_per_sec, features) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, p.maxUsers, p.apiDailyQuota, p.apiRatePerSec, JSON.stringify(p.features)]));
  }
  console.log('seeded plans');

  // Host owner user
  const existingOwner = await control(c => c.query(`SELECT id FROM host_users WHERE email='owner@nexcrm.local'`));
  if (existingOwner.rowCount === 0) {
    const hash = await bcrypt.hash('ChangeMe123!', 10);
    await control(c => c.query(
      `INSERT INTO host_users (email, name, password_hash, role) VALUES ($1,$2,$3,'owner')`,
      ['owner@nexcrm.local', 'Host Owner', hash]));
    console.log('seeded host owner user: owner@nexcrm.local / ChangeMe123!');
  }

  // Test tenant
  const existingTenant = await control(c => c.query(`SELECT id FROM tenants WHERE subdomain='test'`));
  if (existingTenant.rowCount === 0) {
    const tenant = await createTenant({
      name: 'Test Tenant', subdomain: 'test', planCode: 'pro', isTest: true, region: 'in',
      adminEmail: 'admin@test.local', adminName: 'Test Admin', adminPassword: 'ChangeMe123!',
    });
    console.log(`seeded test tenant: code=${tenant.code} subdomain=test admin=admin@test.local / ChangeMe123!`);
  } else {
    console.log('test tenant already exists, skipping');
  }

  await stopDb();
  process.exit(0);
}

seed().catch(e => { console.error(e); process.exit(1); });
