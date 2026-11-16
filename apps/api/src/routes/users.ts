import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant, control } from '../db.js';
import { err, sendError, randToken, sha256 } from '../util.js';
import { requireScope, hashPassword } from '../auth.js';
import { audit } from '../audit.js';
import { validateCustomFields, ensureUniqueFields } from '../services.js';
import { generateTempPassword, createResetLink } from '../credentials.js';
import { generateBase32Secret, otpauthUrl, verifyTotp, generateBackupCodes } from '../totp.js';

export const usersRouter = Router();

function checkPerm(req: any, action: 'view' | 'create' | 'edit' | 'delete') {
  const p = req.auth.perms.user;
  const v = p[action];
  if (action === 'create') { if (!v) throw err(403, 'FORBIDDEN', 'No permission to create users'); return; }
  if (!v || v === false) throw err(403, 'FORBIDDEN', `No permission to ${action} users`);
}

usersRouter.get('/', requireScope('users:read'), async (req, res) => {
  try {
    checkPerm(req, 'view');
    const rows = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT id, email, first_name, last_name, phone, role_id, team_id, manager_id, is_active, is_checked_in, is_system, fields FROM users ORDER BY first_name`)).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

// Creates one user. password is optional — omit it to auto-generate a temp password + a
// one-time set-password link, both returned once (no email sent; admin shares manually).
async function createOneUser(tenantId: string, actorId: string, actorType: string, input: any) {
  const { email, firstName, lastName, phone, password, roleId, teamId, managerId, fields = {} } = input;
  if (!email || !firstName || !roleId) throw err(400, 'MISSING_FIELDS', 'email, firstName, roleId required');
  const generatedPassword = password ? null : generateTempPassword();
  const hash = await hashPassword(password || generatedPassword!);

  /**
   * SEAT LIMIT. `plans.max_users` existed and was sold against from day one, but nothing ever
   * checked it — a tenant on a 10-seat Starter plan could create 500 users and pay for 10.
   * On per-user pricing that is a direct, silent revenue leak, and one a customer discovers
   * long before we would.
   *
   * Counted here rather than in the route so that bulk import, any future provisioning path and
   * the single-create endpoint all share one rule.
   *
   * Billable = active AND not a service account. Note this is NOT `is_system`: that flag means
   * "undeletable" and is true for the tenant Admin as well as the System user. Counting
   * `NOT is_system` handed every customer a free admin seat; the Admin is a person and bills.
   * Only the System placeholder (default owner of unassigned records) is exempt. See
   * migration 015. Deactivated users don't count, so freeing a seat is just deactivating someone.
   *
   * A tenant with no plan row, or max_users <= 0, is treated as unlimited: that is the
   * enterprise/bespoke case, and failing closed there would break existing customers.
   */
  const planLimit = await control(c => c.query(
    `SELECT p.max_users FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [tenantId]));
  const maxUsers: number | null = planLimit.rows[0]?.max_users ?? null;
  if (maxUsers && maxUsers > 0) {
    const used = await withTenant(tenantId, c => c.query(
      `SELECT count(*)::int AS n FROM users WHERE is_active AND is_service_account = false`));
    if (used.rows[0].n >= maxUsers) {
      throw err(402, 'PLAN_USER_LIMIT',
        `Your plan includes ${maxUsers} user${maxUsers === 1 ? '' : 's'} and ${used.rows[0].n} are in use. ` +
        `Deactivate a user to free a seat, or upgrade your plan to add more.`);
    }
  }

  return withTenant(tenantId, async c => {
    if (Object.keys(fields).length) {
      await validateCustomFields(c, 'user', fields);
      await ensureUniqueFields(c, 'user', fields);
    }
    const r = await c.query(
      `INSERT INTO users (tenant_id, email, first_name, last_name, phone, password_hash, role_id, team_id, manager_id, fields, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, email, first_name, last_name, role_id, team_id, manager_id, is_active, fields`,
      [tenantId, email.toLowerCase(), firstName, lastName || null, phone || null, hash, roleId, teamId || null, managerId || null, JSON.stringify(fields), !!generatedPassword]);
    const user = r.rows[0];
    await audit(c, tenantId, actorId, actorType, 'user.created', 'user', user.id, null, user);
    let credentials: any = undefined;
    if (generatedPassword) {
      const link = await createResetLink(c, tenantId, user.id);
      credentials = { tempPassword: generatedPassword, resetUrl: link.url, resetExpiresAt: link.expiresAt };
    }
    return { ...user, ...(credentials ? { generatedCredentials: credentials } : {}) };
  });
}

usersRouter.post('/', requireScope('users:write'), async (req, res) => {
  try {
    checkPerm(req, 'create');
    const row = await createOneUser(req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, req.body || {});
    res.status(201).json(row);
  } catch (e) {
    if ((e as any)?.code === '23505') return sendError(res, err(409, 'EMAIL_EXISTS', 'A user with this email already exists'));
    sendError(res, e);
  }
});

// Bulk create (e.g. from a CSV upload on the frontend, parsed client-side into this array shape).
// Each row succeeds or fails independently; every success gets its own temp password + reset link.
usersRouter.post('/bulk', requireScope('users:write'), async (req, res) => {
  try {
    checkPerm(req, 'create');
    const { users } = req.body || {};
    if (!Array.isArray(users) || !users.length) throw err(400, 'MISSING_FIELDS', 'users array required');
    if (users.length > 500) throw err(400, 'TOO_MANY', 'Max 500 users per bulk request');
    const results: any[] = [];
    for (const u of users) {
      try {
        const created = await createOneUser(req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, u);
        results.push({ email: u.email, status: 'created', user: created });
      } catch (e: any) {
        const code = e?.code === '23505' ? 'EMAIL_EXISTS' : (e?.code || 'ERROR');
        results.push({ email: u.email, status: 'error', error: e?.message || 'Unknown error', code });
      }
    }
    const created = results.filter(r => r.status === 'created').length;
    res.status(201).json({ created, failed: results.length - created, results });
  } catch (e) { sendError(res, e); }
});

// Admin-generated "set your password" link for an existing user (re-invite, forgot password, etc.)
/**
 * MECHANISM 1 — internal password reset. No email provider required, ever.
 *
 * WHY THIS IS THE DEFAULT: expecting a customer to buy a third-party email service before their
 * staff can recover a forgotten password is an unreasonable barrier to purchase. So the baseline
 * flow uses people who are already in the system:
 *
 *   - A tenant admin (user.edit permission) can reset any user.
 *   - A MANAGER can reset anyone below them in the hierarchy — which is who a salesperson
 *     actually asks when they're locked out. Controlled by settings.allowManagerPasswordReset.
 *   - A logged-in user changes their own password via /v1/me/change-password.
 *
 * Returns BOTH a one-time link and a temporary password, so the resetter can pass on whichever
 * suits (WhatsApp a link, or read a temp password over the phone).
 */
usersRouter.post('/:id/reset-link', requireScope('users:write'), async (req, res) => {
  try {
    const out = await withTenant(req.auth!.tenantId, async c => {
      const target = (await c.query(
        `SELECT id, email, first_name, last_name, manager_id, is_system FROM users WHERE id=$1`,
        [req.params.id])).rows[0];
      if (!target) throw err(404, 'NOT_FOUND', 'User not found');

      const settings = (await c.query(`SELECT settings FROM tenants WHERE id=$1`, [req.auth!.tenantId])).rows[0]?.settings || {};
      const managersAllowed = settings.allowManagerPasswordReset !== false;

      // Who is allowed to reset this particular user?
      const hasAdminRight = !!req.auth!.perms.user?.edit;
      let allowed = hasAdminRight;
      let via = 'admin';

      if (!allowed && managersAllowed && req.auth!.actorType === 'user') {
        // Is the target anywhere below the caller in the manager hierarchy?
        const sub = await c.query(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM users WHERE manager_id = $1
             UNION ALL
             SELECT u.id FROM users u JOIN subtree s ON u.manager_id = s.id
           ) SELECT 1 FROM subtree WHERE id = $2 LIMIT 1`,
          [req.auth!.userId, target.id]);
        if (sub.rowCount) { allowed = true; via = 'manager'; }
      }
      // Resetting your own password doesn't need any special permission.
      if (!allowed && target.id === req.auth!.userId) { allowed = true; via = 'self'; }

      if (!allowed) {
        throw err(403, 'FORBIDDEN',
          managersAllowed
            ? 'You can only reset passwords for yourself or for users who report to you'
            : 'Only an administrator can reset passwords for other users');
      }

      const link = await createResetLink(c, req.auth!.tenantId, target.id);
      // Also set a temporary password and force a change at next login, so the resetter can
      // simply read it out if sharing a link is awkward.
      const tempPassword = generateTempPassword();
      const hash = await hashPassword(tempPassword);
      await c.query(
        `UPDATE users SET password_hash=$2, must_change_password=true, updated_at=now() WHERE id=$1`,
        [target.id, hash]);

      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType,
        'user.password_reset', 'user', target.id, null, { via, resetBy: req.auth!.userId });

      return {
        resetUrl: link.url, expiresAt: link.expiresAt, tempPassword, via,
        user: { id: target.id, email: target.email, name: `${target.first_name || ''} ${target.last_name || ''}`.trim() },
      };
    });
    res.status(201).json(out);
  } catch (e) { sendError(res, e); }
});

/**
 * Who can I reset? Drives the UI so a manager sees a reset button only where it will work.
 */
usersRouter.get('/resettable', requireScope('users:read'), async (req, res) => {
  try {
    const out = await withTenant(req.auth!.tenantId, async c => {
      const settings = (await c.query(`SELECT settings FROM tenants WHERE id=$1`, [req.auth!.tenantId])).rows[0]?.settings || {};
      const managersAllowed = settings.allowManagerPasswordReset !== false;
      if (req.auth!.perms.user?.edit) {
        const all = (await c.query(`SELECT id FROM users WHERE is_active`)).rows.map((r: any) => r.id);
        return { mode: 'admin', userIds: all, managersAllowed };
      }
      if (!managersAllowed) return { mode: 'self', userIds: [req.auth!.userId], managersAllowed };
      const sub = (await c.query(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM users WHERE manager_id = $1
           UNION ALL
           SELECT u.id FROM users u JOIN subtree s ON u.manager_id = s.id
         ) SELECT id FROM subtree`, [req.auth!.userId])).rows.map((r: any) => r.id);
      return { mode: 'manager', userIds: [req.auth!.userId, ...sub], managersAllowed };
    });
    res.json(out);
  } catch (e) { sendError(res, e); }
});

usersRouter.patch('/:id', requireScope('users:write'), async (req, res) => {
  try {
    checkPerm(req, 'edit');
    const { firstName, lastName, roleId, teamId, isActive, isCheckedIn, password, fields, managerId } = req.body || {};
    const passwordHash = password ? await hashPassword(password) : null;
    const row = await withTenant(req.auth!.tenantId, async c => {
      const cur = (await c.query(`SELECT id, fields, is_system FROM users WHERE id=$1`, [req.params.id])).rows[0];
      if (!cur) return null;
      if (cur.is_system && isActive === false) throw err(400, 'CANNOT_DEACTIVATE_SYSTEM_USER', 'The System/Admin user cannot be deactivated');

      // Reactivation is the second way past the seat limit: deactivate nobody, just flip old
      // accounts back on. Checked only when a user is actually going inactive -> active, so
      // ordinary edits (rename, role change) on an at-capacity tenant are unaffected.
      if (isActive === true) {
        const wasActive = (await c.query(`SELECT is_active FROM users WHERE id=$1`, [req.params.id])).rows[0]?.is_active;
        if (!wasActive) {
          const limitRow = await control(cc => cc.query(
            `SELECT p.max_users FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [req.auth!.tenantId]));
          const maxUsers: number | null = limitRow.rows[0]?.max_users ?? null;
          if (maxUsers && maxUsers > 0) {
            const used = (await c.query(`SELECT count(*)::int AS n FROM users WHERE is_active AND is_service_account = false`)).rows[0].n;
            if (used >= maxUsers) {
              throw err(402, 'PLAN_USER_LIMIT',
                `Your plan includes ${maxUsers} user${maxUsers === 1 ? '' : 's'} and ${used} are in use. ` +
                `Deactivate another user first, or upgrade your plan.`);
            }
          }
        }
      }
      if (managerId !== undefined && managerId === req.params.id) throw err(400, 'INVALID_MANAGER', 'A user cannot be their own manager');
      let mergedFields = cur.fields;
      if (fields) {
        await validateCustomFields(c, 'user', fields);
        mergedFields = { ...cur.fields, ...fields };
        await ensureUniqueFields(c, 'user', mergedFields, cur.id);
      }
      const r = await c.query(
        `UPDATE users SET first_name=COALESCE($2,first_name), last_name=COALESCE($3,last_name),
         role_id=COALESCE($4,role_id), team_id=COALESCE($5,team_id), is_active=COALESCE($6,is_active),
         is_checked_in=COALESCE($7,is_checked_in), password_hash=COALESCE($8,password_hash), fields=$9,
         manager_id = CASE WHEN $10 THEN $11 ELSE manager_id END, updated_at=now()
         WHERE id=$1 RETURNING id, email, first_name, last_name, role_id, team_id, is_active, is_checked_in, fields, manager_id`,
        [req.params.id, firstName, lastName, roleId, teamId, isActive, isCheckedIn, passwordHash, JSON.stringify(mergedFields),
         managerId !== undefined, managerId ?? null]);
      return r.rows[0];
    });
    if (!row) throw err(404, 'NOT_FOUND', 'User not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

// ---- my profile (any authenticated user) ----
export const meRouter = Router();
meRouter.get('/profile', async (req, res) => {
  try {
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.fields, u.totp_enabled, u.must_change_password, r.name AS role_name
                      FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [req.auth!.userId])).rows[0]);
    res.json(row);
  } catch (e) { sendError(res, e); }
});
meRouter.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) throw err(400, 'MISSING_FIELDS', 'currentPassword, newPassword required');
    if (String(newPassword).length < 8) throw err(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters');
    await withTenant(req.auth!.tenantId, async c => {
      const u = (await c.query(`SELECT password_hash FROM users WHERE id=$1`, [req.auth!.userId])).rows[0];
      if (!u || !(await bcrypt.compare(currentPassword, u.password_hash))) throw err(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
      const hash = await hashPassword(newPassword);
      await c.query(`UPDATE users SET password_hash=$2, must_change_password=false, updated_at=now() WHERE id=$1`, [req.auth!.userId, hash]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, 'user', 'user.password_changed', 'user', req.auth!.userId);
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

// ---- Two-factor authentication (TOTP — Google Authenticator / Authy / 1Password, etc.) ----
// Fully self-contained: no SMS/email provider needed, works entirely off RFC 6238.
meRouter.post('/2fa/setup', async (req, res) => {
  try {
    const secret = generateBase32Secret();
    const email = await withTenant(req.auth!.tenantId, async c => {
      const u = (await c.query(`SELECT email FROM users WHERE id=$1`, [req.auth!.userId])).rows[0];
      // Stash the pending secret; it only becomes active once verified below.
      await c.query(`UPDATE users SET totp_secret=$2 WHERE id=$1`, [req.auth!.userId, secret]);
      return u.email;
    });
    res.json({ secret, otpauthUrl: otpauthUrl(secret, email, 'NexCRM') });
  } catch (e) { sendError(res, e); }
});

meRouter.post('/2fa/verify', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) throw err(400, 'MISSING_FIELDS', 'code required');
    const backupCodes = generateBackupCodes();
    const hashedBackup = backupCodes.map(c => sha256(c));
    await withTenant(req.auth!.tenantId, async c => {
      const u = (await c.query(`SELECT totp_secret FROM users WHERE id=$1`, [req.auth!.userId])).rows[0];
      if (!u?.totp_secret) throw err(400, 'NOT_SETUP', 'Call /2fa/setup first');
      if (!verifyTotp(u.totp_secret, String(code))) throw err(400, 'INVALID_CODE', 'Incorrect or expired code');
      await c.query(`UPDATE users SET totp_enabled=true, totp_backup_codes=$2 WHERE id=$1`, [req.auth!.userId, hashedBackup]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, 'user', 'user.2fa_enabled', 'user', req.auth!.userId);
    });
    res.json({ enabled: true, backupCodes }); // shown once — store somewhere safe
  } catch (e) { sendError(res, e); }
});

meRouter.post('/2fa/disable', async (req, res) => {
  try {
    const { currentPassword } = req.body || {};
    if (!currentPassword) throw err(400, 'MISSING_FIELDS', 'currentPassword required');
    await withTenant(req.auth!.tenantId, async c => {
      const u = (await c.query(`SELECT password_hash FROM users WHERE id=$1`, [req.auth!.userId])).rows[0];
      if (!u || !(await bcrypt.compare(currentPassword, u.password_hash))) throw err(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
      await c.query(`UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_backup_codes=NULL WHERE id=$1`, [req.auth!.userId]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, 'user', 'user.2fa_disabled', 'user', req.auth!.userId);
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

// ---- tenant branding (white-label: name, logo, color) ----
export const brandingRouter = Router();
brandingRouter.get('/', async (req, res) => {
  try {
    const row = (await control(c => c.query(`SELECT name, branding FROM tenants WHERE id=$1`, [req.auth!.tenantId]))).rows[0];
    res.json({ name: row?.name, branding: row?.branding || {} });
  } catch (e) { sendError(res, e); }
});
brandingRouter.patch('/', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageRoles) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
    const { appName, logoUrl, primaryColor } = req.body || {};
    const cur = (await control(c => c.query(`SELECT branding FROM tenants WHERE id=$1`, [req.auth!.tenantId]))).rows[0];
    const branding = { ...(cur?.branding || {}) };
    if (appName !== undefined) branding.appName = appName;
    if (logoUrl !== undefined) branding.logoUrl = logoUrl;
    if (primaryColor !== undefined) branding.primaryColor = primaryColor;
    const row = (await control(c => c.query(`UPDATE tenants SET branding=$2, updated_at=now() WHERE id=$1 RETURNING branding`, [req.auth!.tenantId, JSON.stringify(branding)]))).rows[0];
    res.json({ branding: row.branding });
  } catch (e) { sendError(res, e); }
});

usersRouter.delete('/:id', requireScope('users:delete'), async (req, res) => {
  try {
    checkPerm(req, 'delete');
    await withTenant(req.auth!.tenantId, async c => {
      const cur = (await c.query(`SELECT is_system FROM users WHERE id=$1`, [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'User not found');
      if (cur.is_system) throw err(400, 'CANNOT_DELETE_SYSTEM_USER', 'The System/Admin user cannot be deactivated or deleted');
      await c.query(`UPDATE users SET is_active=false WHERE id=$1`, [req.params.id]);
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

// ---- roles ----
export const rolesRouter = Router();
rolesRouter.get('/', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => (await c.query(`SELECT * FROM roles ORDER BY name`)).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});
rolesRouter.post('/', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageRoles) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
    const { name, description, recordScope = 'own', uiPolicy = {} } = req.body || {};
    if (!name) throw err(400, 'MISSING_FIELDS', 'name required');
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`INSERT INTO roles (tenant_id, name, description, record_scope, ui_policy) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.auth!.tenantId, name, description || null, recordScope, JSON.stringify(uiPolicy)])).rows[0]);
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});
rolesRouter.patch('/:id', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageRoles) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
    const { name, description, recordScope, uiPolicy } = req.body || {};
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`UPDATE roles SET name=COALESCE($2,name), description=COALESCE($3,description),
        record_scope=COALESCE($4,record_scope), ui_policy=COALESCE($5,ui_policy) WHERE id=$1 RETURNING *`,
        [req.params.id, name, description, recordScope, uiPolicy ? JSON.stringify(uiPolicy) : null])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Role not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

// ---- permission sets ----
export const permissionSetsRouter = Router();
permissionSetsRouter.get('/', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => (await c.query(`SELECT * FROM permission_sets ORDER BY name`)).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});
permissionSetsRouter.post('/', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageRoles) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
    const { name, permissions = {} } = req.body || {};
    if (!name) throw err(400, 'MISSING_FIELDS', 'name required');
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`INSERT INTO permission_sets (tenant_id, name, permissions) VALUES ($1,$2,$3) RETURNING *`,
        [req.auth!.tenantId, name, JSON.stringify(permissions)])).rows[0]);
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});
permissionSetsRouter.patch('/:id', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageRoles) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
    const { name, permissions } = req.body || {};
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`UPDATE permission_sets SET name=COALESCE($2,name), permissions=COALESCE($3,permissions) WHERE id=$1 RETURNING *`,
        [req.params.id, name, permissions ? JSON.stringify(permissions) : null])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Permission set not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});
permissionSetsRouter.post('/assign', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageRoles) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
    const { userId, roleId, permissionSetId } = req.body || {};
    if (!permissionSetId || (!userId && !roleId)) throw err(400, 'MISSING_FIELDS', 'permissionSetId and (userId or roleId) required');
    await withTenant(req.auth!.tenantId, async c => {
      if (userId) await c.query(`INSERT INTO user_permission_sets (tenant_id, user_id, permission_set_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.auth!.tenantId, userId, permissionSetId]);
      if (roleId) await c.query(`INSERT INTO role_permission_sets (tenant_id, role_id, permission_set_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.auth!.tenantId, roleId, permissionSetId]);
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

// ---- teams ----
export const teamsRouter = Router();
teamsRouter.get('/', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => (await c.query(`SELECT * FROM teams ORDER BY name`)).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});
teamsRouter.post('/', async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageRoles) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
    const { name, managerUserId } = req.body || {};
    if (!name) throw err(400, 'MISSING_FIELDS', 'name required');
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`INSERT INTO teams (tenant_id, name, manager_user_id) VALUES ($1,$2,$3) RETURNING *`, [req.auth!.tenantId, name, managerUserId || null])).rows[0]);
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

// ---- API keys ----
export const apiKeysRouter = Router();
apiKeysRouter.get('/', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT id, name, key_id, scopes, is_active, last_used_at, created_at FROM api_keys WHERE user_id=$1 OR $2 ORDER BY created_at DESC`,
        [req.auth!.userId, !!req.auth!.perms.settings?.manageRoles])).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});
apiKeysRouter.post('/', async (req, res) => {
  try {
    const { name, scopes = [] } = req.body || {};
    if (!name) throw err(400, 'MISSING_FIELDS', 'name required');
    if (scopes.some((s: string) => s.endsWith(':delete')) && !req.auth!.perms.settings?.manageRoles)
      throw err(403, 'FORBIDDEN', 'Only settings admins can issue delete-scoped keys');
    const keyId = randToken('nx_k_', 8);
    const secret = randToken('nx_s_', 24);
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`INSERT INTO api_keys (tenant_id, user_id, name, key_id, secret_hash, scopes) VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, name, key_id, scopes, created_at`,
        [req.auth!.tenantId, req.auth!.userId, name, keyId, sha256(secret), scopes])).rows[0]);
    res.status(201).json({ ...row, secret }); // secret shown once
  } catch (e) { sendError(res, e); }
});
apiKeysRouter.delete('/:id', async (req, res) => {
  try {
    await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(`UPDATE api_keys SET is_active=false WHERE id=$1 AND (user_id=$2 OR $3) RETURNING id`,
        [req.params.id, req.auth!.userId, !!req.auth!.perms.settings?.manageRoles]);
      if (!r.rowCount) throw err(404, 'NOT_FOUND', 'API key not found');
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});
