/**
 * Break-glass admin recovery CLI.
 *
 * THE PROBLEM THIS SOLVES: connectors are per-tenant, so the admin panel has no tenant email
 * connector to fall back on. If you're locked out of the admin panel and no host email provider
 * is configured, the only alternative is hand-writing SQL against production — which is exactly
 * the situation where mistakes get made.
 *
 * This runs on the SERVER (so possession of the machine is the authentication), needs no email,
 * and costs nothing. It is the correct answer to "how do I recover admin access".
 *
 * USAGE
 *   npx tsx scripts/admin-recovery.ts list
 *   npx tsx scripts/admin-recovery.ts reset  <email> [newPassword]
 *   npx tsx scripts/admin-recovery.ts create <email> "Full Name" [password]
 *   npx tsx scripts/admin-recovery.ts promote <email>
 *   npx tsx scripts/admin-recovery.ts unlock  <email>
 *
 * If no password is supplied, a strong one is generated and printed once.
 *
 * SECURITY NOTE: anyone who can run this owns the platform. Restrict shell access to the
 * production host accordingly, and prefer running it via a one-off container/task rather than
 * leaving an interactive session open.
 */
import bcrypt from 'bcryptjs';
import { initDb, stopDb, control } from '../src/db.js';
function genPassword() {
    // Avoid ambiguous characters so it can be read aloud over a phone without confusion.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    let out = '';
    for (let i = 0; i < 18; i++)
        out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}
function usage() {
    console.log(`
Admin recovery — break-glass access to the admin panel.

  list                                 Show all admin users and their status
  reset  <email> [newPassword]          Reset an admin's password
  create <email> "Full Name" [password] Create a new SUPER admin
  promote <email>                       Make an existing admin a super admin
  unlock <email>                        Re-activate a deactivated admin

If newPassword/password is omitted, a strong one is generated and printed.
`);
    process.exit(1);
}
async function main() {
    const [cmd, arg1, arg2, arg3] = process.argv.slice(2);
    if (!cmd)
        usage();
    await initDb();
    try {
        switch (cmd) {
            case 'list': {
                const rows = (await control(c => c.query(`SELECT hu.email, hu.name, hu.role, hu.is_active, hu.is_super_admin,
                  hu.must_change_password, hu.last_login_at, ht.name AS team
           FROM host_users hu LEFT JOIN host_teams ht ON ht.id = hu.team_id
           ORDER BY hu.is_super_admin DESC, hu.created_at`))).rows;
                if (!rows.length) {
                    console.log('No admin users exist. Create one with:\n  npx tsx scripts/admin-recovery.ts create you@example.com "Your Name"');
                    break;
                }
                console.log(`\n${rows.length} admin user(s):\n`);
                for (const r of rows) {
                    const flags = [
                        r.is_super_admin ? 'SUPER' : r.role,
                        r.is_active ? 'active' : 'DISABLED',
                        r.must_change_password ? 'must-change-pw' : null,
                        r.team ? `team:${r.team}` : null,
                    ].filter(Boolean).join(' · ');
                    const seen = r.last_login_at ? new Date(r.last_login_at).toISOString().slice(0, 16).replace('T', ' ') : 'never';
                    console.log(`  ${r.email.padEnd(34)} ${String(r.name).padEnd(22)} [${flags}]  last login: ${seen}`);
                }
                const supers = rows.filter((r) => r.is_super_admin && r.is_active).length;
                if (supers === 0)
                    console.log('\n  WARNING: no ACTIVE super admin. Promote one:  admin-recovery.ts promote <email>');
                console.log('');
                break;
            }
            case 'reset': {
                if (!arg1)
                    usage();
                const pw = arg2 || genPassword();
                const hash = await bcrypt.hash(pw, 10);
                const r = await control(async (c) => {
                    const u = (await c.query(`SELECT id, email FROM host_users WHERE lower(email)=lower($1)`, [arg1])).rows[0];
                    if (!u)
                        return null;
                    await c.query(`UPDATE host_users SET password_hash=$2, must_change_password=true, is_active=true WHERE id=$1`, [u.id, hash]);
                    // Invalidate any outstanding reset links so an old email can't be replayed.
                    await c.query(`UPDATE host_password_resets SET used_at=now() WHERE host_user_id=$1 AND used_at IS NULL`, [u.id]);
                    await c.query(`INSERT INTO host_audit_log (host_user_id, action, target_type, target_id, detail)
             VALUES (NULL,'host_user.password_reset_cli','host_user',$1,$2)`, [u.id, JSON.stringify({ via: 'admin-recovery CLI' })]);
                    return u;
                });
                if (!r) {
                    console.error(`No admin user with email ${arg1}`);
                    process.exitCode = 1;
                    break;
                }
                console.log(`\n  Password reset for ${r.email}`);
                console.log(`  Temporary password: ${pw}`);
                console.log(`  They must change it at next login.\n`);
                break;
            }
            case 'create': {
                if (!arg1 || !arg2)
                    usage();
                const pw = arg3 || genPassword();
                const hash = await bcrypt.hash(pw, 10);
                try {
                    const u = await control(async (c) => {
                        const row = (await c.query(`INSERT INTO host_users (email, name, password_hash, role, is_super_admin, must_change_password, is_active)
               VALUES ($1,$2,$3,'owner',true,true,true) RETURNING id, email`, [String(arg1).toLowerCase(), arg2, hash])).rows[0];
                        await c.query(`INSERT INTO host_audit_log (host_user_id, action, target_type, target_id, detail)
               VALUES (NULL,'host_user.created_cli','host_user',$1,$2)`, [row.id, JSON.stringify({ via: 'admin-recovery CLI', email: row.email })]);
                        return row;
                    });
                    console.log(`\n  Created SUPER admin ${u.email}`);
                    console.log(`  Temporary password: ${pw}`);
                    console.log(`  They must change it at next login.\n`);
                }
                catch (e) {
                    if (e?.code === '23505')
                        console.error(`An admin user with email ${arg1} already exists — use "reset" instead.`);
                    else
                        throw e;
                    process.exitCode = 1;
                }
                break;
            }
            case 'promote': {
                if (!arg1)
                    usage();
                const r = (await control(c => c.query(`UPDATE host_users SET is_super_admin=true, is_active=true
           WHERE lower(email)=lower($1) RETURNING email`, [arg1]))).rows[0];
                if (!r) {
                    console.error(`No admin user with email ${arg1}`);
                    process.exitCode = 1;
                    break;
                }
                console.log(`\n  ${r.email} is now a super admin.\n`);
                break;
            }
            case 'unlock': {
                if (!arg1)
                    usage();
                const r = (await control(c => c.query(`UPDATE host_users SET is_active=true WHERE lower(email)=lower($1) RETURNING email`, [arg1]))).rows[0];
                if (!r) {
                    console.error(`No admin user with email ${arg1}`);
                    process.exitCode = 1;
                    break;
                }
                console.log(`\n  ${r.email} re-activated.\n`);
                break;
            }
            default:
                usage();
        }
    }
    finally {
        await stopDb();
    }
}
main().catch(e => { console.error('admin-recovery failed:', e?.message || e); process.exit(1); });
