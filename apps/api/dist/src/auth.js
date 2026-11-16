import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { withTenant, control, bypassRLS } from './db.js';
import { config } from './config.js';
import { err, sendError, sha256, randToken, ApiError } from './util.js';
import { loadPermissions, scopeAllows } from './permissions.js';
import { verifyTotp } from './totp.js';
export const authRouter = Router();
function issueSessionToken(user, tenant) {
    return jwt.sign({ sub: user.id, ten: tenant.id, tc: tenant.code, typ: 'tenant', mcp: !!user.must_change_password }, config.jwtSecret, { expiresIn: '12h' });
}
/** Tenant user login: { tenantCode, email, password }. If 2FA is enabled, returns a short-lived
 *  pendingToken instead of a session token — finish with POST /auth/login/2fa. */
authRouter.post('/login', async (req, res) => {
    try {
        const { tenantCode, email, password } = req.body || {};
        if (!tenantCode || !email || !password)
            throw err(400, 'MISSING_FIELDS', 'tenantCode, email, password required');
        const t = await control(c => c.query(`SELECT id, code, status FROM tenants WHERE code=$1 OR subdomain=$1`, [tenantCode]));
        const tenant = t.rows[0];
        if (!tenant)
            throw err(401, 'INVALID_CREDENTIALS', 'Invalid tenant or credentials');
        if (tenant.status !== 'active')
            throw err(403, 'TENANT_SUSPENDED', 'This account is suspended');
        const user = await withTenant(tenant.id, async (c) => {
            const r = await c.query(`SELECT id, email, password_hash, role_id, is_active, must_change_password, totp_enabled FROM users WHERE lower(email)=lower($1)`, [email]);
            return r.rows[0];
        });
        if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash)))
            throw err(401, 'INVALID_CREDENTIALS', 'Invalid tenant or credentials');
        if (user.totp_enabled) {
            const pendingToken = jwt.sign({ sub: user.id, ten: tenant.id, tc: tenant.code, typ: '2fa_pending' }, config.jwtSecret, { expiresIn: '5m' });
            return res.json({ requires2fa: true, pendingToken });
        }
        res.json({ token: issueSessionToken(user, tenant), mustChangePassword: !!user.must_change_password });
    }
    catch (e) {
        sendError(res, e);
    }
});
/** Step 2 of login when 2FA is enabled: { pendingToken, code } — code is a 6-digit TOTP code
 *  or one of the user's unused backup codes. */
authRouter.post('/login/2fa', async (req, res) => {
    try {
        const { pendingToken, code } = req.body || {};
        if (!pendingToken || !code)
            throw err(400, 'MISSING_FIELDS', 'pendingToken, code required');
        let payload;
        try {
            payload = jwt.verify(pendingToken, config.jwtSecret);
        }
        catch {
            throw err(401, 'INVALID_TOKEN', 'Invalid or expired 2FA session — log in again');
        }
        if (payload.typ !== '2fa_pending')
            throw err(401, 'INVALID_TOKEN', 'Wrong token type');
        const tenant = { id: payload.ten, code: payload.tc };
        const result = await withTenant(tenant.id, async (c) => {
            const u = (await c.query(`SELECT * FROM users WHERE id=$1 AND is_active`, [payload.sub])).rows[0];
            if (!u)
                throw err(401, 'USER_INACTIVE', 'User is inactive');
            if (verifyTotp(u.totp_secret, String(code)))
                return u;
            const backupHash = sha256(String(code).trim());
            const backups = u.totp_backup_codes || [];
            if (backups.includes(backupHash)) {
                await c.query(`UPDATE users SET totp_backup_codes=$2 WHERE id=$1`, [u.id, backups.filter(b => b !== backupHash)]);
                return u;
            }
            throw err(401, 'INVALID_2FA_CODE', 'Incorrect authenticator code or backup code');
        });
        res.json({ token: issueSessionToken(result, tenant), mustChangePassword: !!result.must_change_password });
    }
    catch (e) {
        sendError(res, e);
    }
});
/** Consume an admin-generated (or future self-service) "set your password" link. */
authRouter.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body || {};
        if (!token || !newPassword)
            throw err(400, 'MISSING_FIELDS', 'token, newPassword required');
        if (String(newPassword).length < 8)
            throw err(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters');
        const tokenHash = sha256(token);
        // Token lookup happens before we know the tenant, same justification as api-key resolution.
        const row = await bypassRLS(c => c.query(`SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()`, [tokenHash]));
        const reset = row.rows[0];
        if (!reset)
            throw err(400, 'INVALID_OR_EXPIRED_TOKEN', 'This link is invalid or has expired — ask an admin for a new one');
        await withTenant(reset.tenant_id, async (c) => {
            const hash = await hashPassword(newPassword);
            await c.query(`UPDATE users SET password_hash=$2, must_change_password=false, updated_at=now() WHERE id=$1`, [reset.user_id, hash]);
        });
        await bypassRLS(c => c.query(`UPDATE password_resets SET used_at=now() WHERE id=$1`, [reset.id]));
        res.status(204).send();
    }
    catch (e) {
        sendError(res, e);
    }
});
/**
 * Per-tenant IP allowlisting — an enterprise procurement checkbox that costs nothing to run.
 *
 * Supports single IPs and CIDR ranges. Disabled by default; when enabled with an EMPTY list we
 * deliberately allow everything rather than locking the tenant out of their own account (a
 * misconfiguration should not be a self-inflicted outage).
 *
 * Cached briefly to keep this off the hot path — it runs on every authenticated request.
 */
const ipCache = new Map();
const IP_CACHE_MS = 60_000;
/** True if `ip` falls inside `cidr` (IPv4 only; IPv6 entries are compared literally). */
export function ipInCidr(ip, cidr) {
    if (!cidr.includes('/'))
        return ip === cidr;
    const [range, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32)
        return false;
    const toInt = (a) => {
        const p = a.split('.').map(Number);
        if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255))
            return null;
        return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
    };
    const a = toInt(ip), b = toInt(range);
    if (a === null || b === null)
        return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
}
export async function assertIpAllowed(tenantId, req) {
    let entry = ipCache.get(tenantId);
    if (!entry || Date.now() - entry.at > IP_CACHE_MS) {
        const row = (await control(c => c.query(`SELECT ip_allowlist_enabled, ip_allowlist FROM tenants WHERE id=$1`, [tenantId]))).rows[0];
        entry = {
            enabled: !!row?.ip_allowlist_enabled,
            list: Array.isArray(row?.ip_allowlist) ? row.ip_allowlist : [],
            at: Date.now(),
        };
        ipCache.set(tenantId, entry);
    }
    if (!entry.enabled || entry.list.length === 0)
        return;
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
    if (!ip)
        return; // can't determine it — don't lock anyone out
    const allowed = entry.list.some(c => ipInCidr(ip, String(c).trim()));
    if (!allowed)
        throw err(403, 'IP_NOT_ALLOWED', `Access from ${ip} is not permitted for this account`);
}
export function invalidateIpCache(tenantId) { ipCache.delete(tenantId); }
/**
 * Self-serve forgot password for tenant users.
 *
 * ALWAYS responds 200 with the same body whether or not the account exists. Telling an
 * anonymous caller "no such user" turns this endpoint into an account-enumeration oracle —
 * a real and commonly-exploited leak.
 *
 * Delivery goes through the tenant's own email connector first (zero cost to us), then a
 * host provider, then — if neither exists — the link is returned ONLY when the caller is an
 * authenticated admin, never to an anonymous request.
 */
authRouter.post('/forgot-password', async (req, res) => {
    const genericOk = {
        status: 'Success',
        message: 'If an account exists for that email, a reset link has been sent.',
    };
    try {
        const { tenantCode, email } = req.body || {};
        if (!tenantCode || !email)
            throw err(400, 'MISSING_FIELDS', 'tenantCode and email required');
        const t = await control(c => c.query(`SELECT id, code, status, branding, settings FROM tenants WHERE code=$1 OR subdomain=$1`, [tenantCode]));
        const tenant = t.rows[0];
        if (!tenant || tenant.status !== 'active')
            return res.json(genericOk);
        // MECHANISM 2 gate: email-based self-serve reset only runs if the tenant has opted in.
        // The default is 'internal' — an admin or the user's manager performs the reset — because
        // requiring a paid email provider for password recovery would be a barrier to purchase.
        // Returning the same generic response here means we don't advertise which mode they're in.
        const resetMode = (tenant.settings || {}).passwordResetMode || 'internal';
        if (resetMode !== 'email') {
            return res.json({
                ...genericOk,
                // A safe, actionable hint: it names no account and confirms nothing.
                hint: 'This account uses administrator-assisted password reset. Please contact your CRM administrator or your reporting manager to have your password reset.',
            });
        }
        const user = await withTenant(tenant.id, async (c) => (await c.query(`SELECT id, email, first_name, is_active FROM users WHERE lower(email)=lower($1)`, [email])).rows[0]);
        if (!user || !user.is_active)
            return res.json(genericOk);
        // Rate-limit per account so this can't be used to spam someone's inbox.
        const recent = await bypassRLS(c => c.query(`SELECT COUNT(*)::int AS n FROM password_resets
       WHERE user_id=$1 AND created_at > now() - INTERVAL '15 minutes'`, [user.id]));
        if (recent.rows[0].n >= 3)
            return res.json(genericOk);
        const { createResetLink } = await import('./credentials.js');
        const link = await withTenant(tenant.id, c => createResetLink(c, tenant.id, user.id));
        const { sendSystemEmail, resetEmailHtml } = await import('./systemEmail.js');
        await sendSystemEmail({
            tenantId: tenant.id, to: user.email,
            subject: 'Reset your password',
            html: resetEmailHtml({
                name: user.first_name, link: link.url, expiresHours: 24,
                appName: (tenant.branding || {}).appName || 'your CRM',
            }),
        });
        // Deliberately never returns the link to an anonymous caller.
        res.json(genericOk);
    }
    catch (e) {
        // Even on internal failure, don't leak whether the account exists.
        if (e instanceof ApiError && e.status === 400)
            return sendError(res, e);
        console.error('forgot-password failed', e);
        res.json(genericOk);
    }
});
/** Middleware: JWT (Authorization: Bearer) or API key (X-Api-Key-Id / X-Api-Key-Secret). */
export async function requireAuth(req, res, next) {
    try {
        const keyId = req.header('x-api-key-id');
        if (keyId)
            return await apiKeyAuth(req, res, next, keyId);
        const hdr = req.header('authorization') || '';
        let token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        // Narrow exception: the browser EventSource API cannot set an Authorization header, so the
        // SSE stream (and only that path) also accepts ?token=. Deliberately restricted to this one
        // read-only endpoint — accepting tokens in query strings generally would leak them into
        // access logs, browser history and Referer headers.
        if (!token && req.path === '/events/stream' && typeof req.query.token === 'string') {
            token = req.query.token;
        }
        if (!token)
            throw err(401, 'UNAUTHENTICATED', 'Missing credentials');
        let payload;
        try {
            payload = jwt.verify(token, config.jwtSecret);
        }
        catch {
            throw err(401, 'INVALID_TOKEN', 'Invalid or expired token');
        }
        if (payload.typ !== 'tenant')
            throw err(401, 'INVALID_TOKEN', 'Wrong token type');
        await assertIpAllowed(payload.ten, req);
        const ctx = await withTenant(payload.ten, async (c) => {
            const u = await c.query(`SELECT u.id, u.role_id, u.is_active, r.record_scope, r.ui_policy
                               FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id=$1`, [payload.sub]);
            const user = u.rows[0];
            if (!user || !user.is_active)
                throw err(401, 'USER_INACTIVE', 'User is inactive');
            const perms = await loadPermissions(c, user.id, user.role_id);
            return { user, perms };
        });
        req.auth = {
            tenantId: payload.ten, tenantCode: payload.tc, userId: payload.sub,
            roleId: ctx.user.role_id, recordScope: ctx.user.record_scope || 'own',
            perms: ctx.perms, uiPolicy: ctx.user.ui_policy || {}, actorType: 'user',
            mustChangePassword: !!payload.mcp,
        };
        next();
    }
    catch (e) {
        sendError(res, e);
    }
}
/** Mount right after requireAuth on the /v1 router: blocks everything except the
 *  `/me` sub-router (profile, change-password, 2FA) until a forced password change is done. */
export function enforcePasswordChange(req, res, next) {
    if (req.auth?.mustChangePassword && req.auth.actorType === 'user' && !req.path.startsWith('/me')) {
        return sendError(res, err(403, 'PASSWORD_CHANGE_REQUIRED', 'You must set a new password before continuing'));
    }
    next();
}
async function apiKeyAuth(req, res, next, keyId) {
    try {
        const secret = req.header('x-api-key-secret') || '';
        // api_keys is a tenant-RLS-protected table; the tenant isn't known yet at this point, so this
        // lookup must bypass RLS (indexed, single-row, key_id-scoped — see bypassRLS doc comment).
        const k = await bypassRLS(c => c.query(`SELECT ak.*, t.code AS tenant_code, t.status AS tenant_status FROM api_keys ak
       JOIN tenants t ON t.id = ak.tenant_id WHERE ak.key_id=$1`, [keyId]));
        const key = k.rows[0];
        if (!key || !key.is_active || key.secret_hash !== sha256(secret))
            throw err(401, 'INVALID_API_KEY', 'Invalid API key');
        if (key.tenant_status !== 'active')
            throw err(403, 'TENANT_SUSPENDED', 'This account is suspended');
        const ctx = await withTenant(key.tenant_id, async (c) => {
            const u = await c.query(`SELECT u.id, u.role_id, u.is_active, r.record_scope FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [key.user_id]);
            const user = u.rows[0];
            if (!user || !user.is_active)
                throw err(401, 'KEY_OWNER_INACTIVE', 'API key owner is inactive');
            const perms = await loadPermissions(c, user.id, user.role_id);
            await c.query(`UPDATE api_keys SET last_used_at=now() WHERE id=$1`, [key.id]);
            return { user, perms };
        });
        req.auth = {
            tenantId: key.tenant_id, tenantCode: key.tenant_code, userId: key.user_id,
            roleId: ctx.user.role_id, recordScope: ctx.user.record_scope || 'own',
            perms: ctx.perms, uiPolicy: {}, actorType: 'api_key', apiScopes: key.scopes,
            mustChangePassword: false,
        };
        // usage metering
        control(c => c.query(`INSERT INTO api_usage_daily (tenant_id, day, calls) VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (tenant_id, day) DO UPDATE SET calls = api_usage_daily.calls + 1`, [key.tenant_id])).catch(() => { });
        next();
    }
    catch (e) {
        sendError(res, e);
    }
}
/** Guard: API-key scope check (JWT sessions skip scope check — user perms still apply). */
export function requireScope(scope) {
    return (req, res, next) => {
        const a = req.auth;
        if (a.actorType === 'api_key' && !scopeAllows(a.apiScopes || [], scope))
            return sendError(res, err(403, 'INSUFFICIENT_SCOPE', `API key lacks scope: ${scope}`));
        next();
    };
}
/** Host admin auth */
export const hostAuthRouter = Router();
hostAuthRouter.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const r = await control(c => c.query(`SELECT * FROM host_users WHERE lower(email)=lower($1) AND is_active`, [email || '']));
        const hu = r.rows[0];
        if (!hu || !(await bcrypt.compare(password || '', hu.password_hash)))
            throw err(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
        await control(c => c.query(`UPDATE host_users SET last_login_at=now() WHERE id=$1`, [hu.id]));
        const token = jwt.sign({ sub: hu.id, role: hu.role, typ: 'host' }, config.hostJwtSecret, { expiresIn: '12h' });
        res.json({
            token,
            user: { id: hu.id, name: hu.name, email: hu.email, role: hu.role, isSuperAdmin: hu.is_super_admin },
            mustChangePassword: !!hu.must_change_password,
        });
    }
    catch (e) {
        sendError(res, e);
    }
});
/**
 * Host-admin forgot password. Same anti-enumeration stance as the tenant flow: always the same
 * response. Requires a host email provider (SYSTEM_EMAIL_*) — there is no tenant connector to
 * fall back on for admin accounts.
 */
hostAuthRouter.post('/forgot-password', async (req, res) => {
    const genericOk = { status: 'Success', message: 'If an account exists for that email, a reset link has been sent.' };
    try {
        const { email } = req.body || {};
        if (!email)
            throw err(400, 'MISSING_FIELDS', 'email required');
        const hu = (await control(c => c.query(`SELECT id, name, email FROM host_users WHERE lower(email)=lower($1) AND is_active`, [email]))).rows[0];
        if (!hu)
            return res.json(genericOk);
        const recent = await control(c => c.query(`SELECT COUNT(*)::int AS n FROM host_password_resets
       WHERE host_user_id=$1 AND created_at > now() - INTERVAL '15 minutes'`, [hu.id]));
        if (recent.rows[0].n >= 3)
            return res.json(genericOk);
        const raw = randToken('', 24);
        await control(c => c.query(`INSERT INTO host_password_resets (host_user_id, token_hash, expires_at)
       VALUES ($1,$2, now() + INTERVAL '2 hours')`, [hu.id, sha256(raw)]));
        const link = `${config.appUrl}/host/reset-password?token=${encodeURIComponent(raw)}`;
        const { sendSystemEmail, resetEmailHtml } = await import('./systemEmail.js');
        await sendSystemEmail({
            tenantId: null, to: hu.email, subject: 'Reset your admin password',
            html: resetEmailHtml({ name: hu.name, link, expiresHours: 2, appName: 'the admin panel' }),
        });
        res.json(genericOk);
    }
    catch (e) {
        if (e instanceof ApiError && e.status === 400)
            return sendError(res, e);
        console.error('host forgot-password failed', e);
        res.json(genericOk);
    }
});
hostAuthRouter.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body || {};
        if (!token || !newPassword)
            throw err(400, 'MISSING_FIELDS', 'token, newPassword required');
        if (String(newPassword).length < 10)
            throw err(400, 'WEAK_PASSWORD', 'Admin passwords must be at least 10 characters');
        const reset = (await control(c => c.query(`SELECT * FROM host_password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()`, [sha256(token)]))).rows[0];
        if (!reset)
            throw err(400, 'INVALID_OR_EXPIRED_TOKEN', 'This link is invalid or has expired');
        const hash = await hashPassword(newPassword);
        await control(async (c) => {
            await c.query(`UPDATE host_users SET password_hash=$2, must_change_password=false WHERE id=$1`, [reset.host_user_id, hash]);
            await c.query(`UPDATE host_password_resets SET used_at=now() WHERE id=$1`, [reset.id]);
            // Invalidate any other outstanding links for this account.
            await c.query(`UPDATE host_password_resets SET used_at=now() WHERE host_user_id=$1 AND used_at IS NULL`, [reset.host_user_id]);
        });
        res.status(204).send();
    }
    catch (e) {
        sendError(res, e);
    }
});
/**
 * Host-admin permissions.
 *
 * Effective permissions = team defaults merged with the user's own overrides. A super admin
 * implicitly has everything, which avoids the classic lock-out where nobody can grant rights
 * because nobody has the right to grant rights.
 */
export const HOST_PERMISSIONS = [
    'viewTenants', 'createTenants', 'suspendTenants',
    'viewBilling', 'manageBilling',
    'viewUsage', 'manageLimits', 'manageEntitlements', 'manageRetention',
    'manageUiVariants', 'loginAsTenant', 'manageHostUsers', 'exportTenantData',
];
export function hostCan(hostUser, permission) {
    if (!hostUser)
        return false;
    if (hostUser.is_super_admin)
        return true;
    if (hostUser.role === 'owner')
        return true; // legacy owners keep full access
    const merged = { ...(hostUser.team_permissions || {}), ...(hostUser.permissions || {}) };
    return merged[permission] === true;
}
/** Throwing guard for use inside host-admin handlers. */
export function requireHostPermission(req, permission) {
    if (!hostCan(req.hostUser, permission))
        throw err(403, 'FORBIDDEN', `Your admin account lacks the "${permission}" permission`);
}
export async function requireHostAuth(req, res, next) {
    try {
        const hdr = req.header('authorization') || '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        if (!token)
            throw err(401, 'UNAUTHENTICATED', 'Missing credentials');
        let payload;
        try {
            payload = jwt.verify(token, config.hostJwtSecret);
        }
        catch {
            throw err(401, 'INVALID_TOKEN', 'Invalid or expired token');
        }
        if (payload.typ !== 'host')
            throw err(401, 'INVALID_TOKEN', 'Wrong token type');
        const r = await control(c => c.query(`SELECT hu.id, hu.name, hu.email, hu.role, hu.partner_id, hu.is_super_admin, hu.permissions,
              hu.must_change_password, hu.team_id, ht.name AS team_name, ht.permissions AS team_permissions
       FROM host_users hu LEFT JOIN host_teams ht ON ht.id = hu.team_id
       WHERE hu.id=$1 AND hu.is_active`, [payload.sub]));
        if (!r.rows[0])
            throw err(401, 'USER_INACTIVE', 'Host user inactive');
        req.hostUser = r.rows[0];
        next();
    }
    catch (e) {
        sendError(res, e);
    }
}
export const hashPassword = (pw) => bcrypt.hash(pw, 10);
