import crypto from 'node:crypto';
import type { Response } from 'express';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string) {
    super(message);
  }
}

export const err = (status: number, code: string, message: string, field?: string) =>
  new ApiError(status, code, message, field);

export function sendError(res: Response, e: unknown) {
  if (e instanceof ApiError) {
    return res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) } });
  }
  console.error(e);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

export const randToken = (prefix = '', bytes = 24) =>
  prefix + crypto.randomBytes(bytes).toString('base64url');

export const shortCode = (prefix = 't-') =>
  prefix + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export const hmacSign = (secret: string, body: string) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

// slugify a label into an immutable schema name: "City Tier" -> mx_city_tier
export const toSchemaName = (label: string) =>
  'mx_' + label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);

export function normalizePhone(p?: string | null): string | null {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, '');
  return digits || null;
}
