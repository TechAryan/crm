import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// App pool: connects as crm_app (RLS enforced)
export let pool: pg.Pool;
// Admin pool: migrations only
export let adminPool: pg.Pool;

let embedded: any = null;

export async function initDb() {
  if (config.dbMode === 'embedded') {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    // IMPORTANT: never point this at a mounted/synced folder (e.g. the workspace crm/ folder) —
    // Postgres data directories need real filesystem semantics (unlink, fsync, unix sockets),
    // which FUSE-backed synced mounts may not fully support. Use OS temp space instead.
    const dataDir = process.env.EMBEDDED_PG_DIR || path.join(os.tmpdir(), 'nexcrm-embedded-pgdata');
    /**
     * Port is configurable so a second embedded instance can run alongside the first. The e2e
     * suite uses its own port AND its own data directory, which lets `git push` (whose hook runs
     * the suite) work while `npm run dev:api` is still running. Sharing either one meant the test
     * run and the dev server destroyed each other: same directory wiped the developer's data,
     * same port refused to bind.
     */
    const port = parseInt(process.env.EMBEDDED_PG_PORT || '5433', 10);
    embedded = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: true,
    });
    if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
      await embedded.initialise();
    }
    await embedded.start();
    const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${port}/postgres` });
    await admin.connect();
    const dbExists = await admin.query(`SELECT 1 FROM pg_database WHERE datname='nexcrm'`);
    if (dbExists.rowCount === 0) await admin.query('CREATE DATABASE nexcrm');
    await admin.end();
    config.databaseAdminUrl = `postgres://postgres:postgres@localhost:${port}/nexcrm`;
    config.databaseUrl = `postgres://crm_app:crm_app_pw@localhost:${port}/nexcrm`;
  }
  adminPool = new pg.Pool({ connectionString: config.databaseAdminUrl, max: 10 });
  try {
    await migrate();
  } catch (e: any) {
    // A connection/auth failure here surfaces as a raw Postgres error ("role \"postgres\" does
    // not exist", ECONNREFUSED) that names the symptom and hides the cause. In practice the cause
    // is almost always configuration: DB_MODE defaulted to `external` and pointed the app at some
    // unrelated Postgres already running on the machine. Say so.
    const configish = ['28000', '28P01', '3D000', 'ECONNREFUSED', 'ENOTFOUND'].includes(e?.code);
    if (configish && config.dbMode !== 'embedded') {
      const url = config.databaseAdminUrl.replace(/:\/\/[^@]*@/, '://***@');
      throw new Error(
        `Cannot reach the configured database (${e.code}: ${e.message}).\n` +
        `  DB_MODE=${config.dbMode}, so the app tried to connect to an EXTERNAL Postgres at ${url}.\n` +
        `  For local development you almost certainly want the self-contained embedded database:\n` +
        `      set DB_MODE=embedded in your .env  (it runs on port 5433 and will not touch any Postgres you already have)\n` +
        `  If you did intend to use your own Postgres, check that the role, password and database in DATABASE_ADMIN_URL exist.`
      );
    }
    throw e;
  }
  pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
}

export async function stopDb() {
  await pool?.end();
  await adminPool?.end();
  if (embedded) await embedded.stop();
}

/**
 * Locate the db/migrations directory without relying on a fixed __dirname-relative distance —
 * that distance differs between `tsx` (runs from apps/api/src) and the compiled build
 * (runs from apps/api/dist/src), which caused migrations to be "found" in dev but not in a
 * plain `npm run build && npm start` deploy. Instead, walk up from this file's location and
 * also check process.env.MIGRATIONS_DIR / process.cwd() as explicit overrides, so it works
 * whether migrations live at the repo root (local/npm) or a Docker-relocated sibling (/db).
 */
function findMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR && fs.existsSync(process.env.MIGRATIONS_DIR)) return process.env.MIGRATIONS_DIR;
  const candidates: string[] = [];
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'db', 'migrations'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(path.join(process.cwd(), 'db', 'migrations'));
  const found = candidates.find(c => fs.existsSync(c));
  if (!found) throw new Error(`Could not locate db/migrations. Checked:\n${candidates.join('\n')}`);
  return found;
}

export async function migrate() {
  const dir = findMigrationsDir();
  const client = await adminPool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (done.rowCount) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log(`migrated: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Run fn inside a transaction with RLS tenant context set.
 * ALL tenant-scoped queries must go through this.
 */
export async function withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Control-plane queries (tenants, plans, host users) — tables with no RLS policy. Safe on the normal app pool. */
export async function control<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Bypasses Row-Level Security for narrow, system-level credential-resolution queries where the
 * tenant is not yet known (e.g. "which tenant does this API key / webhook token belong to?").
 * Runs on the admin (superuser) connection — never expose this to request bodies/params beyond
 * an indexed token lookup, and never use it for general tenant data access.
 */
export async function bypassRLS<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
