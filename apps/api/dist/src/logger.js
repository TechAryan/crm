// First import: LOG_LEVEL / LOG_FORMAT are read at module scope below, and this module is often
// loaded before config.ts, so it cannot rely on config.ts having loaded `.env`.
import './env.js';
import crypto from 'node:crypto';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;
// Pretty output for local dev; JSON in production so aggregators can parse it.
const PRETTY = process.env.LOG_FORMAT === 'pretty' || (!process.env.LOG_FORMAT && process.env.NODE_ENV !== 'production');
// Simple module-level "current request" holder. AsyncLocalStorage would be more rigorous, but
// it carries measurable overhead; every log call here passes context explicitly instead.
function serialize(level, msg, meta = {}, ctx = {}) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        ...(ctx.actorType ? { actorType: ctx.actorType } : {}),
        ...meta,
    };
    if (!PRETTY)
        return JSON.stringify(entry);
    const tag = ctx.requestId ? ` [${ctx.requestId.slice(0, 8)}]` : '';
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${entry.ts} ${level.toUpperCase().padEnd(5)}${tag} ${msg}${extra}`;
}
function emit(level, msg, meta, ctx) {
    if (LEVELS[level] < MIN_LEVEL)
        return;
    const line = serialize(level, msg, meta, ctx);
    if (level === 'error' || level === 'warn')
        console.error(line);
    else
        console.log(line);
}
export const log = {
    debug: (msg, meta, ctx) => emit('debug', msg, meta, ctx),
    info: (msg, meta, ctx) => emit('info', msg, meta, ctx),
    warn: (msg, meta, ctx) => emit('warn', msg, meta, ctx),
    error: (msg, meta, ctx) => emit('error', msg, meta, ctx),
};
/** A logger bound to one request's context, so handlers don't repeat the ids. */
export function childLogger(ctx) {
    return {
        debug: (m, meta) => emit('debug', m, meta, ctx),
        info: (m, meta) => emit('info', m, meta, ctx),
        warn: (m, meta) => emit('warn', m, meta, ctx),
        error: (m, meta) => emit('error', m, meta, ctx),
    };
}
/**
 * Assigns a request id (honouring an inbound X-Request-Id from a load balancer so a trace spans
 * hops), echoes it in the response so a customer can quote it in a support ticket, and logs one
 * completion line per request.
 */
export function requestLogger() {
    return (req, res, next) => {
        const inbound = req.header('x-request-id');
        const requestId = inbound && /^[\w-]{8,64}$/.test(inbound) ? inbound : crypto.randomUUID();
        req.requestId = requestId;
        res.setHeader('X-Request-Id', requestId);
        const started = process.hrtime.bigint();
        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
            const auth = req.auth;
            const ctx = {
                requestId,
                tenantId: auth?.tenantId, userId: auth?.userId, actorType: auth?.actorType,
            };
            const meta = {
                method: req.method,
                path: req.originalUrl.split('?')[0],
                status: res.statusCode,
                durationMs: Math.round(durationMs * 10) / 10,
            };
            // Server errors are errors; client errors are warnings; the rest is info. Health checks
            // are dropped entirely or they drown everything else.
            if (meta.path === '/health' || meta.path === '/ready')
                return;
            if (res.statusCode >= 500)
                emit('error', 'request failed', meta, ctx);
            else if (res.statusCode >= 400)
                emit('warn', 'request rejected', meta, ctx);
            else
                emit('info', 'request', meta, ctx);
        });
        next();
    };
}
/** Attach handlers for the two failure modes that otherwise kill the process silently. */
export function installCrashHandlers() {
    process.on('unhandledRejection', (reason) => {
        log.error('unhandledRejection', { reason: reason?.message || String(reason), stack: reason?.stack });
    });
    process.on('uncaughtException', (e) => {
        log.error('uncaughtException', { error: e?.message, stack: e?.stack });
        // An uncaught exception leaves the process in an undefined state. Log, then exit so the
        // orchestrator restarts us cleanly rather than serving from a corrupted process.
        setTimeout(() => process.exit(1), 100);
    });
}
