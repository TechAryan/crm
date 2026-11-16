import crypto from 'node:crypto';
export class ApiError extends Error {
    status;
    code;
    field;
    constructor(status, code, message, field) {
        super(message);
        this.status = status;
        this.code = code;
        this.field = field;
    }
}
export const err = (status, code, message, field) => new ApiError(status, code, message, field);
export function sendError(res, e) {
    if (e instanceof ApiError) {
        return res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) } });
    }
    console.error(e);
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
export const randToken = (prefix = '', bytes = 24) => prefix + crypto.randomBytes(bytes).toString('base64url');
export const shortCode = (prefix = 't-') => prefix + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmacSign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
// slugify a label into an immutable schema name: "City Tier" -> mx_city_tier
export const toSchemaName = (label) => 'mx_' + label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
export function normalizePhone(p) {
    if (!p)
        return null;
    const digits = p.replace(/[^\d+]/g, '');
    return digits || null;
}
