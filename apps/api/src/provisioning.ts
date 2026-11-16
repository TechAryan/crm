import { control, withTenant } from './db.js';
import { err, shortCode, toSchemaName } from './util.js';
import { hashPassword } from './auth.js';
import { TEMPLATES } from './templates.js';
import { generateTempPassword, createResetLink } from './credentials.js';

export interface CreateTenantInput {
  name: string; subdomain: string; planCode?: string; isTest?: boolean; region?: string;
  partnerId?: string | null; branding?: any; adminEmail: string; adminName?: string;
  adminPassword?: string; // omit to auto-generate + return a one-time set-password link instead
  template?: string; // vertical starter template code (generic | ecommerce | education | astrology | creator | agency)
}

/** Shared tenant bootstrap: used by host admin API and the seed script. */
export async function createTenant(input: CreateTenantInput) {
  const { name, subdomain, planCode = 'starter', isTest = false, region = 'in', partnerId = null, branding = {},
          adminEmail, adminName = 'Admin', adminPassword, template = 'generic' } = input;

  const tpl = TEMPLATES[template];
  if (!tpl) throw err(400, 'UNKNOWN_TEMPLATE', `Unknown template: ${template}. Available: ${Object.keys(TEMPLATES).join(', ')}`);
  const plan = (await control(c => c.query(`SELECT id FROM plans WHERE code=$1`, [planCode]))).rows[0];
  if (!plan) throw err(400, 'UNKNOWN_PLAN', `Unknown plan: ${planCode}`);
  const code = shortCode('t-');

  const tenant = (await control(c => c.query(
    `INSERT INTO tenants (code, name, subdomain, plan_id, is_test, region, partner_id, branding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [code, name, subdomain, plan.id, isTest, region, partnerId, JSON.stringify(branding)]))).rows[0];

  await withTenant(tenant.id, async c => {
    // --- roles & permission sets (same for every vertical) ---
    const adminPerms = {
      lead: { view: 'all', create: true, edit: 'all', delete: 'all', import: true, export: true },
      activity: { view: 'all', create: true, edit: 'all', delete: 'all' },
      opportunity: { view: 'all', create: true, edit: 'all', delete: 'all' },
      task: { view: 'all', create: true, edit: 'all', delete: 'all' },
      user: { view: 'all', create: true, edit: 'all', delete: 'all' },
      settings: { manageFields: true, manageRoles: true, manageAutomation: true, manageWebhooks: true, manageConnectors: true, manageDistribution: true },
      reports: { view: true },
    };
    const salesPerms = {
      lead: { view: 'own', create: true, edit: 'own', delete: false, import: false, export: false },
      activity: { view: 'own', create: true, edit: 'own', delete: false },
      opportunity: { view: 'own', create: true, edit: 'own', delete: false },
      task: { view: 'own', create: true, edit: 'own', delete: false },
      user: { view: false, create: false, edit: false, delete: false },
      settings: {}, reports: { view: false },
    };
    // 'team' scope = the caller plus everyone under them in the manager hierarchy (see
    // permissions.ts resolveVisibleOwnerIds) — this is what makes a manager's view naturally
    // follow the org chart instead of seeing the whole tenant.
    const managerPerms = {
      lead: { view: 'team', create: true, edit: 'team', delete: 'own', import: false, export: true },
      activity: { view: 'team', create: true, edit: 'team', delete: 'own' },
      opportunity: { view: 'team', create: true, edit: 'team', delete: 'own' },
      task: { view: 'team', create: true, edit: 'team', delete: 'own' },
      user: { view: 'all', create: false, edit: false, delete: false },
      settings: { manageDistribution: true }, reports: { view: true },
    };
    // The System user's permission set is separate from Administrator's so an admin can
    // dial System's access up/down without touching real human admins' permissions.
    const systemPerms = {
      lead: { view: 'all', create: true, edit: 'all', delete: 'all', import: true, export: true },
      activity: { view: 'all', create: true, edit: 'all', delete: 'all' },
      opportunity: { view: 'all', create: true, edit: 'all', delete: 'all' },
      task: { view: 'all', create: true, edit: 'all', delete: 'all' },
      user: { view: 'all', create: true, edit: 'all', delete: 'all' },
      settings: { manageFields: true, manageRoles: true, manageAutomation: true, manageWebhooks: true, manageConnectors: true, manageDistribution: true },
      reports: { view: true },
    };
    const psAdmin = (await c.query(`INSERT INTO permission_sets (tenant_id, name, permissions, is_system) VALUES ($1,'Administrator',$2,true) RETURNING id`, [tenant.id, JSON.stringify(adminPerms)])).rows[0];
    const psSales = (await c.query(`INSERT INTO permission_sets (tenant_id, name, permissions, is_system) VALUES ($1,'Sales User',$2,true) RETURNING id`, [tenant.id, JSON.stringify(salesPerms)])).rows[0];
    const psManager = (await c.query(`INSERT INTO permission_sets (tenant_id, name, permissions, is_system) VALUES ($1,'Sales Manager',$2,true) RETURNING id`, [tenant.id, JSON.stringify(managerPerms)])).rows[0];
    const psSystem = (await c.query(`INSERT INTO permission_sets (tenant_id, name, permissions, is_system) VALUES ($1,'System',$2,true) RETURNING id`, [tenant.id, JSON.stringify(systemPerms)])).rows[0];

    const roleAdmin = (await c.query(`INSERT INTO roles (tenant_id, name, record_scope, is_system, ui_policy) VALUES ($1,'Admin','all',true,'{}') RETURNING id`, [tenant.id])).rows[0];
    const roleManager = (await c.query(`INSERT INTO roles (tenant_id, name, record_scope, is_system, ui_policy) VALUES ($1,'Sales Manager','team',true,'{}') RETURNING id`, [tenant.id])).rows[0];
    const roleSales = (await c.query(`INSERT INTO roles (tenant_id, name, record_scope, is_system, ui_policy) VALUES ($1,'Sales User','own',true,$2) RETURNING id`,
      [tenant.id, JSON.stringify({ hiddenTabs: ['Settings', 'Reports'] })])).rows[0];
    const roleSystem = (await c.query(`INSERT INTO roles (tenant_id, name, record_scope, is_system, ui_policy) VALUES ($1,'System','all',true,'{}') RETURNING id`, [tenant.id])).rows[0];

    await c.query(`INSERT INTO role_permission_sets (tenant_id, role_id, permission_set_id) VALUES ($1,$2,$3),($1,$4,$5),($1,$6,$7),($1,$8,$9)`,
      [tenant.id, roleAdmin.id, psAdmin.id, roleManager.id, psManager.id, roleSales.id, psSales.id, roleSystem.id, psSystem.id]);

    // --- vertical template: stages ---
    for (const s of tpl.stages) {
      await c.query(`INSERT INTO lead_stages (tenant_id, name, is_active_stage, sort_order, is_default) VALUES ($1,$2,$3,$4,$5)`,
        [tenant.id, s.name, s.active, s.order, !!s.isDefault]);
    }
    // --- sources ---
    for (const src of tpl.sources) {
      await c.query(`INSERT INTO lead_sources (tenant_id, name, is_system) VALUES ($1,$2,true) ON CONFLICT (tenant_id, name) DO NOTHING`, [tenant.id, src]);
    }
    // --- system activity types (always) + template scoring activities ---
    await c.query(
      `INSERT INTO activity_types (tenant_id, name, direction, score, is_system) VALUES
       ($1,'Lead Captured',0,0,true), ($1,'Stage Changed',0,0,true), ($1,'Owner Changed',0,0,true),
       ($1,'WhatsApp Message Received',0,5,true), ($1,'WhatsApp Message Sent',1,0,true), ($1,'Note Added',1,0,true),
       ($1,'Incoming Call',0,5,true), ($1,'Outbound Call',1,0,true)`, [tenant.id]);
    for (const at of tpl.activityTypes) {
      await c.query(`INSERT INTO activity_types (tenant_id, name, direction, score, is_system) VALUES ($1,$2,$3,$4,false) ON CONFLICT (tenant_id, name) DO NOTHING`,
        [tenant.id, at.name, at.direction, at.score]);
    }
    // --- template lead fields ---
    let order = 100;
    for (const f of tpl.leadFields) {
      await c.query(
        `INSERT INTO custom_field_defs (tenant_id, entity, schema_name, label, field_type, options, sort_order)
         VALUES ($1,'lead',$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, entity, schema_name) DO NOTHING`,
        [tenant.id, toSchemaName(f.label), f.label, f.type, f.options ? JSON.stringify(f.options) : null, order += 10]);
    }
    // --- opportunity types ---
    for (const ot of tpl.opportunityTypes) {
      await c.query(`INSERT INTO opportunity_types (tenant_id, name, stages) VALUES ($1,$2,$3)`,
        [tenant.id, ot.name, JSON.stringify(ot.stages)]);
    }

    // --- system field-defs: built-in columns, renameable/hideable from Settings, never deletable ---
    const systemFields: [string, string, string, number][] = [
      ['first_name', 'First Name', 'lead', 10], ['last_name', 'Last Name', 'lead', 20],
      ['email', 'Email', 'lead', 30], ['phone', 'Phone', 'lead', 40], ['additional_phone', 'Additional Phone', 'lead', 50],
      ['stage', 'Lead Stage', 'lead', 60], ['source', 'Lead Source', 'lead', 70], ['owner', 'Lead Owner', 'lead', 80],
      ['score', 'Lead Score', 'lead', 90], ['lead_number', 'Lead Number', 'lead', 100], ['created_at', 'Created On', 'lead', 110],
      ['name', 'Opportunity Name', 'opportunity', 10], ['stage', 'Stage', 'opportunity', 20],
      ['amount', 'Amount', 'opportunity', 30], ['currency', 'Currency', 'opportunity', 40], ['owner', 'Owner', 'opportunity', 50],
      ['email', 'Email', 'user', 10], ['first_name', 'First Name', 'user', 20], ['last_name', 'Last Name', 'user', 30],
      ['phone', 'Phone', 'user', 40], ['role', 'Role', 'user', 50],
    ];
    for (const [schemaName, label, entity, sortOrder] of systemFields) {
      await c.query(
        `INSERT INTO custom_field_defs (tenant_id, entity, schema_name, label, field_type, is_system, is_deletable, sort_order)
         VALUES ($1,$2,$3,$4,'text',true,false,$5) ON CONFLICT (tenant_id, entity, schema_name) DO NOTHING`,
        [tenant.id, entity, schemaName, label, sortOrder]);
    }

    // --- admin user (first user of every tenant: Admin role, full permissions — see psAdmin above) ---
    // Both Admin and System are is_system=true: neither can be deleted/deactivated (see users.ts DELETE).
    const generatedPassword = adminPassword ? null : generateTempPassword();
    const hash = await hashPassword(adminPassword || generatedPassword!);
    const adminUser = (await c.query(
      `INSERT INTO users (tenant_id, email, first_name, last_name, password_hash, role_id, must_change_password, is_system)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
      [tenant.id, adminEmail.toLowerCase(), adminName, 'Admin', hash, roleAdmin.id, !!generatedPassword])).rows[0];

    if (generatedPassword) {
      const link = await createResetLink(c, tenant.id, adminUser.id);
      (tenant as any).generatedCredentials = { tempPassword: generatedPassword, resetUrl: link.url, resetExpiresAt: link.expiresAt };
    }

    // --- System user: default owner for unassigned records; email is tenantcode@nextcrm.com;
    // password unknown to anyone until an admin generates a reset link for it (Settings > Users).
    const systemEmail = `${tenant.code.toLowerCase()}@nextcrm.com`;
    const systemPassword = generateTempPassword();
    const systemHash = await hashPassword(systemPassword);
    await c.query(
      // is_service_account=true: this is the default-owner placeholder, not a person, so it must
      // never consume a paid seat. is_system=true separately keeps it undeletable.
      `INSERT INTO users (tenant_id, email, first_name, last_name, password_hash, role_id, must_change_password, is_system, is_service_account)
       VALUES ($1,$2,'System','User',$3,$4,true,true,true)`,
      [tenant.id, systemEmail, systemHash, roleSystem.id]);
  });

  return tenant;
}
