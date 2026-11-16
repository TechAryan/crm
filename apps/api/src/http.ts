import dns from 'node:dns/promises';
import net from 'node:net';
import { err } from './util.js';

/**
 * Hardened outbound HTTP client for tenant-configured URLs (custom actions, automation
 * http_call actions, API-sourced dropdown options).
 *
 * SECURITY — this is the single most sensitive component in the product. Tenant admins can
 * make our server issue requests to URLs they choose, which is textbook SSRF. Without the
 * guards below, a tenant could reach cloud instance metadata (169.254.169.254), our own
 * database/API on localhost, or anything else inside the private network — from a trusted
 * source IP. Everything here exists for that reason:
 *
 *  1. Scheme allow-list (https only by default; http permitted only if explicitly enabled).
 *  2. DNS resolution + IP range checks BEFORE connecting, on every hostname, so DNS names
 *     that point at private space are rejected too (not just literal private IPs).
 *  3. Redirects are followed manually so each hop is re-validated — a public URL that
 *     302s to 169.254.169.254 must not slip through.
 *  4. Hard timeout, response size cap, and a capped number of redirects.
 *  5. Every call is logged by the caller (outbound_calls) for audit + debugging.
 *
 * DNS-rebinding note: between our resolution check and Node's own connect, a hostile DNS
 * server could theoretically change the answer (TOCTOU). Fully closing that needs a custom
 * socket factory pinned to the validated IP. The guards here block the realistic attacks;
 * the residual rebinding window is documented as a known limitation rather than hidden.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata', 'metadata.google.internal', 'metadata.goog',
]);

/** True if the IP is loopback/private/link-local/CGNAT/multicast/reserved — i.e. not publicly routable. */
export function isBlockedIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 0) return true;                          // 0.0.0.0/8 "this network"
    if (a === 10) return true;                         // private
    if (a === 127) return true;                        // loopback
    if (a === 169 && b === 254) return true;           // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // private
    if (a === 192 && b === 168) return true;           // private
    if (a === 192 && b === 0) return true;             // 192.0.0.0/24 protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true;                         // multicast + reserved + broadcast
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / -embedded (::ffff:169.254.169.254, ::ffff:7f00:1) — validate the inner v4
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (lower === '::' || lower === '::1') return true;         // unspecified / loopback
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // unique-local fc00::/7
    if (lower.startsWith('ff')) return true;                    // multicast
    if (lower.startsWith('::ffff:')) return true;               // any other v4-mapped form
    if (lower.startsWith('64:ff9b:')) return true;              // NAT64
    return false;
  }
  return true; // not a valid IP literal
}

export interface HttpCallOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  allowHttp?: boolean;   // opt-in plain http (e.g. a customer's internal-but-public endpoint)
  maxRedirects?: number;
}

export interface HttpCallResult {
  ok: boolean;
  status: number | null;
  body: string;
  error: string | null;
  durationMs: number;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Validate a single URL hop: scheme, hostname, and every resolved IP. Throws ApiError if unsafe. */
async function assertSafeUrl(raw: string, allowHttp: boolean): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); }
  catch { throw err(400, 'INVALID_URL', `Not a valid URL: ${raw}`); }

  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:'))
    throw err(400, 'URL_SCHEME_BLOCKED', `Only https:// URLs are allowed (got ${u.protocol}). Enable "allow plain http" on the action if you really need http.`);

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal'))
    throw err(400, 'URL_HOST_BLOCKED', `Blocked hostname: ${u.hostname}`);

  // Literal IP in the URL — check directly (no DNS needed).
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw err(400, 'URL_HOST_BLOCKED', `Blocked private/reserved IP: ${host}`);
    return u;
  }

  let addrs: { address: string }[];
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw err(400, 'URL_DNS_FAILED', `Could not resolve host: ${u.hostname}`); }
  if (!addrs.length) throw err(400, 'URL_DNS_FAILED', `Host resolved to no addresses: ${u.hostname}`);
  // ALL resolved addresses must be public — a host with one public and one private A record
  // must be rejected, otherwise the connect could pick the private one.
  for (const a of addrs) {
    if (isBlockedIp(a.address))
      throw err(400, 'URL_HOST_BLOCKED', `${u.hostname} resolves to a private/reserved address (${a.address}), which is not allowed`);
  }
  return u;
}

/**
 * Perform a guarded outbound HTTP call. Never throws for remote-side failures (returns
 * ok:false with the error) — only throws ApiError for locally-rejected/unsafe requests,
 * so config mistakes surface as 400s while remote outages surface as call results.
 */
export async function safeHttpCall(opts: HttpCallOptions): Promise<HttpCallResult> {
  const started = Date.now();
  const method = (opts.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw err(400, 'INVALID_METHOD', `Unsupported HTTP method: ${method}`);

  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 10_000, 1_000), 30_000);
  const maxBytes = Math.min(Math.max(opts.maxBytes ?? 256 * 1024, 1024), 2 * 1024 * 1024);
  const maxRedirects = Math.min(opts.maxRedirects ?? 3, 5);

  // Strip hop-by-hop / spoofable headers a tenant shouldn't control.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers || {})) {
    const key = k.toLowerCase();
    if (['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade'].includes(key)) continue;
    if (v === null || v === undefined) continue;
    headers[k] = String(v);
  }
  if (opts.body && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type'))
    headers['content-type'] = 'application/json';

  let url = opts.url;
  let redirects = 0;

  while (true) {
    const validated = await assertSafeUrl(url, !!opts.allowHttp);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(validated.toString(), {
        method,
        headers,
        body: method === 'GET' || method === 'DELETE' ? undefined : (opts.body ?? undefined),
        redirect: 'manual',          // re-validate every hop ourselves
        signal: controller.signal,
      });

      // Manual redirect handling so each new location is SSRF-checked too.
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (loc && redirects < maxRedirects) {
          redirects++;
          url = new URL(loc, validated).toString();
          clearTimeout(timer);
          continue;
        }
        if (loc) {
          clearTimeout(timer);
          return { ok: false, status: resp.status, body: '', error: `Too many redirects (>${maxRedirects})`, durationMs: Date.now() - started };
        }
      }

      // Read at most maxBytes so a huge/streaming response can't exhaust memory.
      let text = '';
      if (resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) { text += '…[truncated]'; await reader.cancel().catch(() => {}); break; }
          text += decoder.decode(value, { stream: true });
        }
      }
      clearTimeout(timer);
      return { ok: resp.ok, status: resp.status, body: text, error: resp.ok ? null : `HTTP ${resp.status}`, durationMs: Date.now() - started };
    } catch (e: any) {
      clearTimeout(timer);
      const aborted = e?.name === 'AbortError';
      return {
        ok: false, status: null, body: '',
        error: aborted ? `Timed out after ${timeoutMs}ms` : (e?.message || 'Request failed'),
        durationMs: Date.now() - started,
      };
    }
  }
}
