import crypto from 'node:crypto';
import { config } from './config.js';
import { err } from './util.js';
/**
 * Envelope encryption for tenant-supplied third-party credentials (Gupshup API keys, SMTP
 * passwords, Razorpay secrets, telephony tokens…).
 *
 * WHY: customers bring their own provider accounts, so we hold credentials that are not ours.
 * Storing those in plaintext would mean a single DB read — a backup leak, a rogue query, an
 * SQL injection anywhere — exposes every customer's provider accounts. AES-256-GCM gives us
 * confidentiality plus integrity (the auth tag detects tampering).
 *
 * KEY MANAGEMENT — read this before production:
 *   - The key comes from CREDENTIALS_KEY (base64, 32 bytes). Generate with:
 *       openssl rand -base64 32
 *   - In production this MUST come from a secrets manager (AWS KMS / Secrets Manager,
 *     GCP Secret Manager), NOT a .env file committed anywhere.
 *   - Rotating the key requires re-encrypting existing rows; the stored format carries a
 *     version prefix ("v1:") so a future rotation can decrypt old rows and re-wrap them.
 *   - If the key is lost, stored credentials are unrecoverable by design. Customers would
 *     need to re-enter them. That is the correct trade-off versus a recoverable scheme.
 */
const VERSION = 'v1';
function getKey() {
    const raw = config.credentialsKey;
    if (!raw) {
        throw err(500, 'ENCRYPTION_NOT_CONFIGURED', 'CREDENTIALS_KEY is not set — cannot store or read third-party credentials. Generate one with: openssl rand -base64 32');
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
        throw err(500, 'ENCRYPTION_MISCONFIGURED', `CREDENTIALS_KEY must decode to exactly 32 bytes (got ${key.length}). Generate with: openssl rand -base64 32`);
    }
    return key;
}
/** True if a usable encryption key is configured (used to surface a clear setup warning). */
export function encryptionAvailable() {
    try {
        getKey();
        return true;
    }
    catch {
        return false;
    }
}
/** Encrypt a JSON-serialisable object. Returns "v1:<iv>:<tag>:<ciphertext>" (all base64). */
export function encryptSecrets(obj) {
    const key = getKey();
    const iv = crypto.randomBytes(12); // 96-bit nonce, GCM standard
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}
/** Decrypt a stored blob back to the original object. Throws if tampered or key is wrong. */
export function decryptSecrets(blob) {
    if (!blob)
        return {};
    const parts = blob.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION)
        throw err(500, 'DECRYPT_FAILED', 'Stored credential blob is not in the expected format');
    const key = getKey();
    const [, ivB64, tagB64, ctB64] = parts;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
        return JSON.parse(pt.toString('utf8'));
    }
    catch {
        // Either the key changed or the ciphertext was tampered with. Don't leak which.
        throw err(500, 'DECRYPT_FAILED', 'Could not decrypt stored credentials — the encryption key may have changed');
    }
}
/**
 * Mask a secret for display: keeps a short prefix/suffix so the user can recognise which key
 * is stored without revealing it. Secrets are NEVER returned in full by any API response.
 */
export function maskSecret(v) {
    const s = String(v ?? '');
    if (!s)
        return '';
    if (s.length <= 8)
        return '••••';
    return `${s.slice(0, 3)}••••${s.slice(-2)}`;
}
/** Mask every value of a secrets object for safe display. */
export function maskSecrets(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {}))
        out[k] = maskSecret(v);
    return out;
}
