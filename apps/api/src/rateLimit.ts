import type { Request, Response, NextFunction } from 'express';

// Simple in-memory sliding-window rate limiter. Good enough for a single node;
// swap for a Redis-backed limiter when running multiple API instances.
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

// Periodic cleanup so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref?.();

export function rateLimit(opts: { windowMs: number; max: number; keyPrefix: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.headers['x-forwarded-for'] as string || '').split(',')[0].trim() || req.ip || 'unknown';
    const key = `${opts.keyPrefix}:${ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + opts.windowMs }; buckets.set(key, b); }
    b.count++;
    const remaining = Math.max(0, opts.max - b.count);
    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (b.count > opts.max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down.' } });
    }
    next();
  };
}

// For tests: reset all counters.
export function _resetRateLimits() { buckets.clear(); }
