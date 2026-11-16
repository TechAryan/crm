import crypto from 'node:crypto';
import type pg from 'pg';
import { config } from './config.js';
import { sha256 } from './util.js';

/**
 * No SMTP/SMS provider is connected yet, so we can't email or text credentials to a new user.
 * Instead: generate a strong temporary password AND a one-time "set your password" link, return
 * both from the create-user API response, and let the admin share either one manually (Slack,
 * WhatsApp, in person, etc.) until real mail delivery is wired up. The temp password forces a
 * change on first login either way (see users.must_change_password + the login/2FA flow in auth.ts).
 */
export function generateTempPassword(): string {
  // Readable-ish: avoids ambiguous chars (0/O, 1/l/I), still high entropy (~72 bits over 14 chars).
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function createResetLink(client: pg.PoolClient, tenantId: string, userId: string): Promise<{ token: string; url: string; expiresAt: Date }> {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await client.query(
    `INSERT INTO password_resets (tenant_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [tenantId, userId, sha256(token), expiresAt]);
  return { token, url: `${config.appUrl}/reset-password?token=${token}`, expiresAt };
}
