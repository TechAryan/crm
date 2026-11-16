// Minimal RFC 6238 (TOTP) / RFC 4226 (HOTP) implementation — no external dependency,
// so 2FA works with zero third-party services (Google Authenticator, Authy, 1Password, etc.
// all implement this same open standard and need nothing from us but the shared secret).
import crypto from 'node:crypto';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function generateBase32Secret(bytes = 20) {
    const buf = crypto.randomBytes(bytes);
    let bits = '';
    for (const b of buf)
        bits += b.toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i + 5 <= bits.length; i += 5)
        out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
    return out;
}
function base32Decode(input) {
    const clean = input.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
    let bits = '';
    for (const ch of clean) {
        const idx = BASE32_ALPHABET.indexOf(ch);
        if (idx === -1)
            continue;
        bits += idx.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8)
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
}
function hotp(secret, counter, digits = 6) {
    const key = base32Decode(secret);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
    return String(bin % 10 ** digits).padStart(digits, '0');
}
export function totpNow(secret, stepSeconds = 30, digits = 6, at = Date.now()) {
    return hotp(secret, Math.floor(at / 1000 / stepSeconds), digits);
}
/** Verify a 6-digit code, allowing +-1 time step of clock drift. */
export function verifyTotp(secret, token, stepSeconds = 30, window = 1) {
    if (!/^\d{6}$/.test(token))
        return false;
    const counter = Math.floor(Date.now() / 1000 / stepSeconds);
    for (let w = -window; w <= window; w++) {
        if (hotp(secret, counter + w) === token)
            return true;
    }
    return false;
}
export function otpauthUrl(secret, accountLabel, issuer = 'NexCRM') {
    const label = encodeURIComponent(`${issuer}:${accountLabel}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
export function generateBackupCodes(count = 8) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        codes.push(crypto.randomBytes(5).toString('hex').match(/.{1,4}/g).join('-'));
    }
    return codes;
}
