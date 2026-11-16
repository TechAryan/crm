import type { Request, Response, NextFunction } from 'express';
import { withTenant } from './db.js';

/**
 * API request/response logging.
 *
 * WHY: when a customer's integration "isn't working", the only way to answer it without a
 * screen-share is a record of what they actually sent and what we actually returned. This is the
 * single most useful support tool in an API-heavy product.
 *
 * WHY IT'S BOUNDED (and billable): logging every body forever is both a storage cost and a
 * privacy liability. So:
 *   - secrets are REDACTED before storage (passwords, tokens, keys, card-ish fields);
 *   - bodies are truncated;
 *   - successful GETs store no body at all (high volume, low diagnostic value);
 *   - response bodies are kept only for failures by default;
 *   - retention defaults to 7 days and is raised per tenant from the admin panel as a paid
 *     upgrade — which is honest, because longer retention genuinely costs us more storage.
 *
 * Writes are fire-and-forget: logging must never add latency to or fail a real request.
 */

const MAX_BODY = 4000;

// Field names whose values must never be persisted, matched case-insensitively anywhere in the key.
const REDACT_KEYS = [
  'password', 'currentpassword', 'newpassword', 'secret', 'token', 'apikey', 'api_key',
  'authorization', 'auth', 'credentials', 'privatekey', 'accesskey', 'authtoken', 'sessionid',
  'card', 'cardnumber', 'cvv', 'cvc', 'pin', 'otp', 'totp', 'backupcode', 'databaseurl',
  'credentialskey', 'jwtsecret', 'signature',
];

function shouldRedact(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z]/g, '');
  return REDACT_KEYS.some(r => k.includes(r));
}

/** Deep-redact an object, preserving shape so the log stays useful for debugging. */
export function redact(value: any, depth = 0): any {
  if (depth > 6) return '[depth-limited]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = shouldRedact(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function truncate(s: string): string {
  return s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}…[truncated ${s.length - MAX_BODY} chars]` : s;
}

function serialize(body: any): string | null {
  if (body === undefined || body === null) return null;
  try {
    const s = typeof body === 'string' ? body : JSON.stringify(redact(body));
    return s && s !== '{}' ? truncate(s) : null;
  } catch { return null; }
}

/**
 * Express middleware. Mount after auth (so the tenant/actor is known) and after the body parser.
 * Captures the response body by wrapping res.json — only used for error responses by default.
 */
export function apiRequestLogger(opts: { logSuccessBodies?: boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    let capturedBody: any;

    // Wrap res.json to observe the payload without buffering the whole stream.
    const originalJson = res.json.bind(res);
    (res as any).json = (body: any) => { capturedBody = body; return originalJson(body); };

    res.on('finish', () => {
      const auth = (req as any).auth;
      if (!auth?.tenantId) return;          // unauthenticated paths aren't tenant-scoped

      const duration = Date.now() - started;
      const status = res.statusCode;
      const isError = status >= 400;

      // Successful GETs: metadata only. They're the bulk of traffic and their bodies are just
      // data the caller already has.
      const storeReq = !(req.method === 'GET' && !isError);
      const storeRes = isError || opts.logSuccessBodies === true;

      const row = {
        tenantId: auth.tenantId,
        method: req.method,
        path: req.originalUrl.split('?')[0].slice(0, 500),
        status,
        duration,
        actorId: auth.userId || null,
        actorType: auth.actorType || null,
        ip: ((req.headers['x-forwarded-for'] as string) || '').split(',')[0].trim() || req.ip || null,
        userAgent: (req.headers['user-agent'] || '').toString().slice(0, 300) || null,
        requestBody: storeReq ? serialize(req.body) : null,
        responseBody: storeRes ? serialize(capturedBody) : null,
        errorCode: isError ? (capturedBody?.error?.code || null) : null,
      };

      // Fire-and-forget: a logging failure must never surface to the caller.
      withTenant(row.tenantId, c => c.query(
        `INSERT INTO api_request_log (tenant_id, method, path, status_code, duration_ms, actor_id,
           actor_type, ip, user_agent, request_body, response_body, error_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row.tenantId, row.method, row.path, row.status, row.duration, row.actorId, row.actorType,
         row.ip, row.userAgent, row.requestBody, row.responseBody, row.errorCode]
      )).catch(e => console.error('api log write failed', e?.message || e));
    });

    next();
  };
}
