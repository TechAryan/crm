import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { control } from '../db.js';
import { err, sendError, randToken, sha256 } from '../util.js';
import { HOST_PERMISSIONS, requireHostPermission, hostCan } from '../auth.js';
import { config } from '../config.js';
/**
 * Admin-panel team management: multiple admin users with their own logins, grouped into teams
 * (Sales / Tech / Support / Billing), each with granular permissions, plus an audit trail of
 * every admin action.
 *
 * WHY: the moment more than one person touches the admin panel, "everyone is an owner" becomes
 * a liability — a salesperson shouldn't be able to change a tenant's technical limits, and you
 * need to know who suspended a customer. A super admin decides who gets what.
 */
export const hostTeamRouter = Router();
/** Record an admin-panel action. Fire-and-forget: auditing must not break the action. */
export async function hostAudit(hostUserId, action, targetType, targetId, detail = null) {
    try {
        await control(c => c.query(`INSERT INTO host_audit_log (host_user_id, action, target_type, target_id, detail)
       VALUES ($1,$2,$3,$4,$5)`, [hostUserId, action, targetType, targetId, detail ? JSON.stringify(detail) : null]));
    }
    catch (e) {
        console.error('host audit write failed', e);
    }
}
// ---------------------------------------------------------------------------
// Who am I / what can I do
// ---------------------------------------------------------------------------
hostTeamRouter.get('/me', (req, res) => {
    const hu = req.hostUser;
    const effective = {};
    for (const p of HOST_PERMISSIONS)
        effective[p] = hostCan(hu, p);
    // A legacy 'owner' has full rights in hostCan(), so report them as a super admin too —
    // otherwise the UI would hide controls the API would actually permit.
    const isSuper = !!hu.is_super_admin || hu.role === 'owner';
    res.json({
        id: hu.id, name: hu.name, email: hu.email, role: hu.role,
        isSuperAdmin: isSuper, team: hu.team_name || null,
        mustChangePassword: !!hu.must_change_password,
        permissions: effective,
        allPermissions: HOST_PERMISSIONS,
    });
});
// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------
hostTeamRouter.get('/teams', async (req, res) => {
    try {
        requireHostPermission(req, 'manageHostUsers');
        const rows = (await control(c => c.query(`SELECT t.*, (SELECT COUNT(*)::int FROM host_users u WHERE u.team_id = t.id) AS member_count
       FROM host_teams t ORDER BY t.name`))).rows;
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
hostTeamRouter.post('/teams', async (req, res) => {
    try {
        requireHostPermission(req, 'manageHostUsers');
        const { name, description, permissions = {} } = req.body || {};
        if (!name)
            throw err(400, 'MISSING_FIELDS', 'name required');
        for (const k of Object.keys(permissions)) {
            if (!HOST_PERMISSIONS.includes(k))
                throw err(400, 'UNKNOWN_PERMISSION', `Unknown permission: ${k}. Valid: ${HOST_PERMISSIONS.join(', ')}`);
        }
        const row = (await control(c => c.query(`INSERT INTO host_teams (name, description, permissions) VALUES ($1,$2,$3) RETURNING *`, [name, description || null, JSON.stringify(permissions)]))).rows[0];
        await hostAudit(req.hostUser.id, 'host_team.created', 'host_team', row.id, { name, permissions });
        res.status(201).json(row);
    }
    catch (e) {
        if (e?.code === '23505')
            return sendError(res, err(409, 'TEAM_EXISTS', 'A team with this name already exists'));
        sendError(res, e);
    }
});
hostTeamRouter.patch('/teams/:id', async (req, res) => {
    try {
        requireHostPermission(req, 'manageHostUsers');
        const { name, description, permissions } = req.body || {};
        if (permissions) {
            for (const k of Object.keys(permissions)) {
                if (!HOST_PERMISSIONS.includes(k))
                    throw err(400, 'UNKNOWN_PERMISSION', `Unknown permission: ${k}`);
            }
        }
        const before = (await control(c => c.query(`SELECT * FROM host_teams WHERE id=$1`, [req.params.id]))).rows[0];
        if (!before)
            throw err(404, 'NOT_FOUND', 'Team not found');
        const row = (await control(c => c.query(`UPDATE host_teams SET name=COALESCE($2,name), description=COALESCE($3,description),
         permissions=COALESCE($4,permissions) WHERE id=$1 RETURNING *`, [req.params.id, name, description, permissions ? JSON.stringify(permissions) : null]))).rows[0];
        await hostAudit(req.hostUser.id, 'host_team.updated', 'host_team', row.id, { before: before.permissions, after: row.permissions });
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---------------------------------------------------------------------------
// Admin users
// ---------------------------------------------------------------------------
hostTeamRouter.get('/users', async (req, res) => {
    try {
        requireHostPermission(req, 'manageHostUsers');
        const rows = (await control(c => c.query(`SELECT hu.id, hu.name, hu.email, hu.role, hu.is_active, hu.is_super_admin, hu.permissions,
              hu.last_login_at, hu.created_at, ht.name AS team_name
       FROM host_users hu LEFT JOIN host_teams ht ON ht.id = hu.team_id
       ORDER BY hu.created_at`))).rows;
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
/**
 * Invite an admin user. No password is chosen here — we issue a one-time set-password link,
 * so a plaintext password never travels over chat/email and nobody (including you) knows it.
 */
hostTeamRouter.post('/users', async (req, res) => {
    try {
        requireHostPermission(req, 'manageHostUsers');
        const { email, name, teamName, permissions = {}, isSuperAdmin = false, role = 'support' } = req.body || {};
        if (!email || !name)
            throw err(400, 'MISSING_FIELDS', 'email and name required');
        // Only an existing super admin (or legacy owner) may mint another one.
        if (isSuperAdmin && !(req.hostUser.is_super_admin || req.hostUser.role === 'owner'))
            throw err(403, 'FORBIDDEN', 'Only a super admin can create another super admin');
        for (const k of Object.keys(permissions)) {
            if (!HOST_PERMISSIONS.includes(k))
                throw err(400, 'UNKNOWN_PERMISSION', `Unknown permission: ${k}`);
        }
        const out = await control(async (c) => {
            let teamId = null;
            if (teamName) {
                const t = (await c.query(`SELECT id FROM host_teams WHERE name=$1`, [teamName])).rows[0];
                if (!t)
                    throw err(404, 'NOT_FOUND', `Team '${teamName}' not found`);
                teamId = t.id;
            }
            // Random unusable password; the invite link is the only way in.
            const tmp = randToken('', 18);
            const hash = await bcrypt.hash(tmp, 10);
            const u = (await c.query(`INSERT INTO host_users (email, name, password_hash, role, team_id, permissions, is_super_admin, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         RETURNING id, email, name, role, is_super_admin`, [String(email).toLowerCase(), name, hash, role, teamId, JSON.stringify(permissions), isSuperAdmin])).rows[0];
            const raw = randToken('', 24);
            await c.query(`INSERT INTO host_password_resets (host_user_id, token_hash, expires_at)
         VALUES ($1,$2, now() + INTERVAL '48 hours')`, [u.id, sha256(raw)]);
            return { user: u, inviteUrl: `${config.appUrl}/host/reset-password?token=${encodeURIComponent(raw)}` };
        });
        await hostAudit(req.hostUser.id, 'host_user.invited', 'host_user', out.user.id, { email, teamName, permissions, isSuperAdmin });
        // Try to email it; if no provider is configured, hand the link back so you can pass it on.
        const { sendSystemEmail, resetEmailHtml } = await import('../systemEmail.js');
        const mail = await sendSystemEmail({
            tenantId: null, to: out.user.email, subject: 'Your admin panel invitation',
            html: resetEmailHtml({ name: out.user.name, link: out.inviteUrl, expiresHours: 48, appName: 'the admin panel' }),
            fallbackLink: out.inviteUrl,
        });
        res.status(201).json({
            user: out.user,
            emailSent: mail.sent,
            // Only surfaced to an authenticated admin who just created the account.
            inviteUrl: mail.sent ? undefined : out.inviteUrl,
            note: mail.sent ? 'Invitation emailed.' : 'No email provider configured — share this invite link yourself.',
        });
    }
    catch (e) {
        if (e?.code === '23505')
            return sendError(res, err(409, 'EMAIL_EXISTS', 'An admin user with this email already exists'));
        sendError(res, e);
    }
});
hostTeamRouter.patch('/users/:id', async (req, res) => {
    try {
        requireHostPermission(req, 'manageHostUsers');
        const { name, teamName, permissions, isActive, isSuperAdmin, role } = req.body || {};
        if (isSuperAdmin !== undefined && !(req.hostUser.is_super_admin || req.hostUser.role === 'owner'))
            throw err(403, 'FORBIDDEN', 'Only a super admin can change super-admin status');
        if (permissions) {
            for (const k of Object.keys(permissions)) {
                if (!HOST_PERMISSIONS.includes(k))
                    throw err(400, 'UNKNOWN_PERMISSION', `Unknown permission: ${k}`);
            }
        }
        const row = await control(async (c) => {
            const cur = (await c.query(`SELECT * FROM host_users WHERE id=$1`, [req.params.id])).rows[0];
            if (!cur)
                throw err(404, 'NOT_FOUND', 'Admin user not found');
            // Don't allow removing the last super admin — that locks everyone out permanently.
            if ((isSuperAdmin === false || isActive === false) && cur.is_super_admin) {
                const others = (await c.query(`SELECT COUNT(*)::int AS n FROM host_users WHERE is_super_admin AND is_active AND id <> $1`, [req.params.id])).rows[0].n;
                if (others === 0)
                    throw err(400, 'LAST_SUPER_ADMIN', 'This is the last active super admin — promote someone else first');
            }
            let teamId = undefined;
            if (teamName !== undefined) {
                if (teamName === null)
                    teamId = null;
                else {
                    const t = (await c.query(`SELECT id FROM host_teams WHERE name=$1`, [teamName])).rows[0];
                    if (!t)
                        throw err(404, 'NOT_FOUND', `Team '${teamName}' not found`);
                    teamId = t.id;
                }
            }
            return (await c.query(`UPDATE host_users SET name=COALESCE($2,name),
           team_id = CASE WHEN $3::boolean THEN $4::uuid ELSE team_id END,
           permissions=COALESCE($5,permissions), is_active=COALESCE($6,is_active),
           is_super_admin=COALESCE($7,is_super_admin), role=COALESCE($8,role)
         WHERE id=$1
         RETURNING id, name, email, role, is_active, is_super_admin, permissions`, [req.params.id, name, teamId !== undefined, teamId ?? null,
                permissions ? JSON.stringify(permissions) : null, isActive, isSuperAdmin, role])).rows[0];
        });
        await hostAudit(req.hostUser.id, 'host_user.updated', 'host_user', req.params.id, req.body);
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---------------------------------------------------------------------------
// Admin action audit trail
// ---------------------------------------------------------------------------
hostTeamRouter.get('/audit', async (req, res) => {
    try {
        // Any admin can see the trail — visibility is a feature, not a risk.
        const params = [];
        const clauses = ['1=1'];
        if (req.query.hostUserId) {
            params.push(req.query.hostUserId);
            clauses.push(`h.host_user_id = $${params.length}`);
        }
        if (req.query.action) {
            params.push(`${req.query.action}%`);
            clauses.push(`h.action LIKE $${params.length}`);
        }
        if (req.query.targetId) {
            params.push(req.query.targetId);
            clauses.push(`h.target_id = $${params.length}`);
        }
        const limit = Math.min(500, parseInt(String(req.query.limit || '100')));
        params.push(limit);
        const rows = (await control(c => c.query(`SELECT h.*, hu.name AS actor_name, hu.email AS actor_email
       FROM host_audit_log h LEFT JOIN host_users hu ON hu.id = h.host_user_id
       WHERE ${clauses.join(' AND ')} ORDER BY h.id DESC LIMIT $${params.length}`, params))).rows;
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
