// First import: LOG_LEVEL / LOG_FORMAT are read at module scope below, and this module is often
// loaded before config.ts, so it cannot rely on config.ts having loaded `.env`.
import './env.js';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Structured JSON logging with request correlation ids.
 *
 * WHY BEFORE THE FIRST CUSTOMER: when a customer says "it failed around 3pm", `console.log`
 * output is nearly useless — you cannot filter it, correlate it, or search it. One JSON line per
 * event with a request id turns a support ticket into a single grep. It also means log
 * aggregation (Loki/CloudWatch) works the day you add it, with no code change.
 *
 * Deliberately dependency-free (no pino/winston): the whole implementation is ~80 lines, and
 * every dependency is a supply-chain surface plus something to keep updated.
 *
 * Output goes to stdout, which is what every container platform collects by default.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL as LogLevel) || 'info'] ?? 20;
// Pretty output for local dev; JSON in production so aggregators can parse it.
const PRETTY = process.env.LOG_FORMAT === 'pretty' || (!process.env.LOG_FORMAT && process.env.NODE_ENV !== 'production');

/** Per-request context, carried so every line from one request shares its id. */
interface LogContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  actorType?: string;
}

// Simple module-level "current request" holder. AsyncLocalStorage would be more rigorous, but
// it carries measurable overhead; every log call here passes context explicitly instead.
function serialize(level: LogLevel, msg: string, meta: Record<string, any> = {}, ctx: LogContext = {}) {
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
  if (!PRETTY) return JSON.stringify(entry);
  const tag = ctx.requestId ? ` [${ctx.requestId.slice(0, 8)}]` : '';
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${entry.ts} ${level.toUpperCase().padEnd(5)}${tag} ${msg}${extra}`;
}

function emit(level: LogLevel, msg: string, meta?: Record<string, any>, ctx?: LogContext) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = serialize(level, msg, meta, ctx);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, meta?: Record<string, any>, ctx?: LogContext) => emit('debug', msg, meta, ctx),
  info: (msg: string, meta?: Record<string, any>, ctx?: LogContext) => emit('info', msg, meta, ctx),
  warn: (msg: string, meta?: Record<string, any>, ctx?: LogContext) => emit('warn', msg, meta, ctx),
  error: (msg: string, meta?: Record<string, any>, ctx?: LogContext) => emit('error', msg, meta, ctx),
};

/** A logger bound to one request's context, so handlers don't repeat the ids. */
export function childLogger(ctx: LogContext) {
  return {
    debug: (m: string, meta?: Record<string, any>) => emit('debug', m, meta, ctx),
    info: (m: string, meta?: Record<string, any>) => emit('info', m, meta, ctx),
    warn: (m: string, meta?: Record<string, any>) => emit('warn', m, meta, ctx),
    error: (m: string, meta?: Record<string, any>) => emit('error', m, meta, ctx),
  };
}

/**
 * Assigns a request id (honouring an inbound X-Request-Id from a load balancer so a trace spans
 * hops), echoes it in the response so a customer can quote it in a support ticket, and logs one
 * completion line per request.
 */
export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.header('x-request-id');
    const requestId = inbound && /^[\w-]{8,64}$/.test(inbound) ? inbound : crypto.randomUUID();
    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const auth = (req as any).auth;
      const ctx: LogContext = {
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
      if (meta.path === '/health' || meta.path === '/ready') return;
      if (res.statusCode >= 500) emit('error', 'request failed', meta, ctx);
      else if (res.statusCode >= 400) emit('warn', 'request rejected', meta, ctx);
      else emit('info', 'request', meta, ctx);
    });

    next();
  };
}

/** Attach handlers for the two failure modes that otherwise kill the process silently. */
export function installCrashHandlers() {
  process.on('unhandledRejection', (reason: any) => {
    log.error('unhandledRejection', { reason: reason?.message || String(reason), stack: reason?.stack });
  });
  process.on('uncaughtException', (e: any) => {
    log.error('uncaughtException', { error: e?.message, stack: e?.stack });
    // An uncaught exception leaves the process in an undefined state. Log, then exit so the
    // orchestrator restarts us cleanly rather than serving from a corrupted process.
    setTimeout(() => process.exit(1), 100);
  });
}
