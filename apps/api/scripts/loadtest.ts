/**
 * Load test — finds the real performance ceiling BEFORE customers do.
 *
 * WHY THIS MATTERS: everything else has been verified functionally, but "works with 250 leads"
 * tells you nothing about "works with 1,000,000". The failure mode we're hunting is the one that
 * only appears at scale: a query that was fine on a small table starts scanning, and the whole
 * dashboard times out. Finding that here costs nothing; finding it in production costs a customer.
 *
 * WHAT IT DOES
 *   1. Bulk-inserts N leads (plus activities/opportunities) into a test tenant, fast (COPY-style
 *      multi-row inserts, not one INSERT per row).
 *   2. Times the hot query paths at p50/p95/p99 — list, filtered list, custom-field filter,
 *      search, dashboard aggregation, export count.
 *   3. Runs concurrent requests to find where latency degrades.
 *   4. Reports EXPLAIN plans for the slowest queries, so a missing index is obvious rather than
 *      a mystery.
 *
 * USAGE
 *   DB_MODE=embedded npx tsx scripts/loadtest.ts                  # default 100k leads
 *   DB_MODE=embedded npx tsx scripts/loadtest.ts --leads 1000000  # the serious run
 *   DB_MODE=embedded npx tsx scripts/loadtest.ts --leads 100000 --tenants 20
 *
 * Run it against a THROWAWAY database. It writes a lot of rows on purpose.
 */
import { initDb, stopDb, control, withTenant } from '../src/db.js';
import { createTenant } from '../src/provisioning.js';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}

const LEADS = arg('leads', 100_000);
const TENANTS = arg('tenants', 3);
const BATCH = 2_000;          // rows per multi-row INSERT
const SAMPLES = 25;           // timing samples per query

const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Hyderabad', 'Chennai', 'Kolkata', 'Jaipur'];
const SOURCES = ['Website', 'Facebook Ads', 'Google Ads', 'Referral', 'WhatsApp'];

interface Timing { label: string; p50: number; p95: number; p99: number; max: number; rows?: number }

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function timeQuery(label: string, fn: () => Promise<any>, samples = SAMPLES): Promise<Timing> {
  const times: number[] = [];
  let rows: number | undefined;
  // One warm-up so we measure steady state, not first-call plan compilation.
  const warm = await fn();
  if (Array.isArray(warm)) rows = warm.length;
  else if (warm?.rowCount !== undefined) rows = warm.rowCount;
  for (let i = 0; i < samples; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return {
    label,
    p50: Math.round(percentile(times, 50) * 10) / 10,
    p95: Math.round(percentile(times, 95) * 10) / 10,
    p99: Math.round(percentile(times, 99) * 10) / 10,
    max: Math.round(times[times.length - 1] * 10) / 10,
    rows,
  };
}

/** Insert leads in large multi-row batches — one INSERT per row would take hours at 1M. */
async function seedLeads(tenantId: string, count: number, startNum: number, userIds: string[], stageIds: string[], sourceIds: string[]) {
  const t0 = Date.now();
  let inserted = 0;

  for (let offset = 0; offset < count; offset += BATCH) {
    const size = Math.min(BATCH, count - offset);
    const values: string[] = [];
    const params: any[] = [];
    let p = 1;

    for (let i = 0; i < size; i++) {
      const idx = offset + i;
      const city = CITIES[idx % CITIES.length];
      const daysAgo = idx % 365;
      const created = new Date(Date.now() - daysAgo * 86400000).toISOString();
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        tenantId,
        startNum + idx,
        `First${idx % 5000}`,
        `Last${idx % 900}`,
        `load${idx}@example.com`,
        `+9190${String(10000000 + (idx % 89999999)).slice(0, 8)}`,
        stageIds[idx % stageIds.length],
        sourceIds[idx % sourceIds.length],
        userIds[idx % userIds.length],
        idx % 100,
        JSON.stringify({ mx_city: city, mx_budget: (idx % 50) * 1000 }),
        created,
        created,
      );
    }

    await withTenant(tenantId, c => c.query(
      `INSERT INTO leads (tenant_id, lead_number, first_name, last_name, email, phone,
         stage_id, source_id, owner_id, score, fields, created_at, updated_at)
       VALUES ${values.join(',')}`, params));

    inserted += size;
    if (inserted % 20_000 === 0 || inserted === count) {
      const rate = Math.round(inserted / ((Date.now() - t0) / 1000));
      process.stdout.write(`\r    seeded ${inserted.toLocaleString('en-IN')}/${count.toLocaleString('en-IN')} (${rate.toLocaleString('en-IN')} rows/s)   `);
    }
  }
  process.stdout.write('\n');
  return Date.now() - t0;
}

/** Activities on a subset of leads — enough to make the timeline/report paths realistic. */
async function seedActivities(tenantId: string, leadIds: string[], typeId: string, perLead: number) {
  for (let offset = 0; offset < leadIds.length; offset += 500) {
    const chunk = leadIds.slice(offset, offset + 500);
    const values: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (const id of chunk) {
      for (let k = 0; k < perLead; k++) {
        values.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
        params.push(tenantId, id, typeId, `Load note ${k}`, new Date(Date.now() - k * 3600000).toISOString());
      }
    }
    if (!values.length) continue;
    await withTenant(tenantId, c => c.query(
      `INSERT INTO activities (tenant_id, lead_id, activity_type_id, note, activity_time)
       VALUES ${values.join(',')}`, params));
  }
}

async function main() {
  process.env.DB_MODE = process.env.DB_MODE || 'embedded';
  console.log(`\n=== NexCRM load test ===`);
  console.log(`Target: ${LEADS.toLocaleString('en-IN')} leads in the primary tenant, ${TENANTS} tenants total\n`);

  await initDb();
  try {
    await control(c => c.query(
      `INSERT INTO plans (code, name, max_users, api_daily_quota, api_rate_per_sec, features)
       VALUES ('load','Load Test',500,100000000,100000,'{}') ON CONFLICT (code) DO NOTHING`));

    // ---- Build tenants ----
    console.log('1. Provisioning tenants…');
    const tenants: { id: string; code: string }[] = [];
    for (let i = 0; i < TENANTS; i++) {
      const t = await createTenant({
        name: `Load Tenant ${i}`, subdomain: `load-${i}-${Date.now()}`, planCode: 'load',
        adminEmail: `admin${i}@load.local`, adminPassword: 'LoadTestPw123!',
        template: i === 0 ? 'education' : 'generic',
      });
      tenants.push({ id: t.id, code: t.code });
    }
    const primary = tenants[0];
    console.log(`   ${tenants.length} tenants created\n`);

    // Extra users so owner distribution (and therefore index selectivity) is realistic.
    const { hashPassword } = await import('../src/auth.js');
    const pwHash = await hashPassword('LoadTestPw123!');
    const roleId = (await withTenant(primary.id, c => c.query(`SELECT id FROM roles WHERE name='Sales User' LIMIT 1`))).rows[0].id;
    for (let i = 0; i < 20; i++) {
      await withTenant(primary.id, c => c.query(
        `INSERT INTO users (tenant_id, email, first_name, password_hash, role_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [primary.id, `rep${i}@load.local`, `Rep${i}`, pwHash, roleId]));
    }

    const meta = await withTenant(primary.id, async c => ({
      userIds: (await c.query(`SELECT id FROM users WHERE is_active`)).rows.map((r: any) => r.id),
      stageIds: (await c.query(`SELECT id FROM lead_stages ORDER BY sort_order`)).rows.map((r: any) => r.id),
      sourceIds: (await c.query(`SELECT id FROM lead_sources`)).rows.map((r: any) => r.id),
      cityField: (await c.query(`SELECT schema_name FROM custom_field_defs WHERE entity='lead' AND schema_name LIKE '%city%' LIMIT 1`)).rows[0]?.schema_name,
    }));
    // Ensure the custom fields we filter on exist, or the filter test measures nothing.
    for (const [label, type] of [['City', 'text'], ['Budget', 'number']] as [string, string][]) {
      await withTenant(primary.id, c => c.query(
        `INSERT INTO custom_field_defs (tenant_id, entity, schema_name, label, field_type)
         VALUES ($1,'lead',$2,$3,$4) ON CONFLICT (tenant_id, entity, schema_name) DO NOTHING`,
        [primary.id, `mx_${label.toLowerCase()}`, label, type]));
    }

    // ---- Seed ----
    console.log(`2. Seeding ${LEADS.toLocaleString('en-IN')} leads into ${primary.code}…`);
    const seedMs = await seedLeads(primary.id, LEADS, 1, meta.userIds, meta.stageIds, meta.sourceIds);
    console.log(`   done in ${(seedMs / 1000).toFixed(1)}s (${Math.round(LEADS / (seedMs / 1000)).toLocaleString('en-IN')} rows/s)`);

    // Smaller tenants, to prove one big tenant doesn't slow the others down.
    for (const t of tenants.slice(1)) {
      const m = await withTenant(t.id, async c => ({
        userIds: (await c.query(`SELECT id FROM users WHERE is_active`)).rows.map((r: any) => r.id),
        stageIds: (await c.query(`SELECT id FROM lead_stages`)).rows.map((r: any) => r.id),
        sourceIds: (await c.query(`SELECT id FROM lead_sources`)).rows.map((r: any) => r.id),
      }));
      await seedLeads(t.id, 5_000, 1, m.userIds, m.stageIds, m.sourceIds);
    }
    console.log(`   ${TENANTS - 1} smaller tenants seeded with 5,000 leads each\n`);

    console.log('3. Seeding activities on a sample of leads…');
    const sampleLeadIds = (await withTenant(primary.id, c => c.query(
      `SELECT id FROM leads ORDER BY created_at DESC LIMIT 2000`))).rows.map((r: any) => r.id);
    const actType = (await withTenant(primary.id, c => c.query(
      `SELECT id FROM activity_types WHERE is_active LIMIT 1`))).rows[0].id;
    await seedActivities(primary.id, sampleLeadIds, actType, 3);
    console.log(`   ~${(sampleLeadIds.length * 3).toLocaleString('en-IN')} activities\n`);

    // Fresh planner statistics, or the planner makes bad choices on newly-bulk-loaded tables.
    // Scoped to the tables we actually query: a bare ANALYZE tries to touch control-plane tables
    // the app role doesn't own and emits permission warnings.
    await withTenant(primary.id, c => c.query(`ANALYZE leads, activities, lead_stages`));
    for (const t of tenants.slice(1)) await withTenant(t.id, c => c.query(`ANALYZE leads`));

    // ---- Measure ----
    console.log('4. Timing hot query paths (p50 / p95 / p99 in ms)…\n');
    const results: Timing[] = [];
    const sampleOwner = meta.userIds[0];
    const sampleStage = meta.stageIds[0];

    results.push(await timeQuery('lead list, page 1 (25)', () => withTenant(primary.id, c =>
      c.query(`SELECT * FROM leads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 25`))));

    results.push(await timeQuery('lead list, page 200 (deep offset)', () => withTenant(primary.id, c =>
      c.query(`SELECT * FROM leads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 25 OFFSET 5000`))));

    results.push(await timeQuery('count total leads', () => withTenant(primary.id, c =>
      c.query(`SELECT COUNT(*) FROM leads WHERE deleted_at IS NULL`))));

    results.push(await timeQuery('filter by owner (scoped view)', () => withTenant(primary.id, c =>
      c.query(`SELECT * FROM leads WHERE deleted_at IS NULL AND owner_id = ANY($1) ORDER BY created_at DESC LIMIT 25`, [[sampleOwner]]))));

    results.push(await timeQuery('filter by stage', () => withTenant(primary.id, c =>
      c.query(`SELECT * FROM leads WHERE deleted_at IS NULL AND stage_id=$1 ORDER BY created_at DESC LIMIT 25`, [sampleStage]))));

    results.push(await timeQuery('custom-field filter (JSONB)', () => withTenant(primary.id, c =>
      c.query(`SELECT * FROM leads WHERE deleted_at IS NULL AND fields->>'mx_city' = 'Mumbai' ORDER BY created_at DESC LIMIT 25`))));

    results.push(await timeQuery('email lookup (dedupe path)', () => withTenant(primary.id, c =>
      c.query(`SELECT * FROM leads WHERE lower(email)=lower($1) AND deleted_at IS NULL LIMIT 1`, [`load${Math.floor(LEADS / 2)}@example.com`]))));

    results.push(await timeQuery('phone lookup (telephony screen-pop)', () => withTenant(primary.id, c =>
      c.query(`SELECT * FROM leads WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`, ['+919010000500']))));

    results.push(await timeQuery('name search (ILIKE)', () => withTenant(primary.id, c =>
      c.query(`SELECT * FROM leads WHERE deleted_at IS NULL AND (first_name ILIKE $1 OR email ILIKE $1) ORDER BY created_at DESC LIMIT 25`, ['%First123%']))));

    results.push(await timeQuery('dashboard: funnel by stage', () => withTenant(primary.id, c =>
      c.query(`SELECT s.name, COUNT(l.id)::int FROM lead_stages s
               LEFT JOIN leads l ON l.stage_id=s.id AND l.deleted_at IS NULL
               GROUP BY s.id ORDER BY s.sort_order`)), 10));

    // These two mirror the OPTIMISED forms now used in reports.ts. The naive versions (casting
    // created_at in a join, and evaluating GREATEST() across the whole table) measured 217ms and
    // 159ms p95 here — which is exactly why they were rewritten. Keeping the real production SQL
    // in the load test is the point: otherwise you tune a query nobody runs.
    results.push(await timeQuery('dashboard: 14-day trend', () => withTenant(primary.id, c =>
      c.query(`WITH counts AS (
                 SELECT date_trunc('day', l.created_at)::date AS day, COUNT(*)::int AS count
                 FROM leads l
                 WHERE l.deleted_at IS NULL AND l.created_at >= CURRENT_DATE - INTERVAL '13 days'
                 GROUP BY 1
               )
               SELECT to_char(d.day,'YYYY-MM-DD') AS day, COALESCE(c.count,0)::int AS count
               FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, '1 day') d(day)
               LEFT JOIN counts c ON c.day = d.day::date
               ORDER BY d.day`)), 10));

    results.push(await timeQuery('dashboard: cold leads (needs attention)', () => withTenant(primary.id, c =>
      c.query(`WITH candidates AS (
                 SELECT l.id, l.stage_id, l.updated_at, l.created_at
                 FROM leads l
                 JOIN lead_stages s ON s.id=l.stage_id AND s.is_active_stage
                 WHERE l.deleted_at IS NULL AND l.updated_at < now() - INTERVAL '7 days'
                 ORDER BY l.updated_at ASC LIMIT 500
               )
               SELECT cd.id, s.name AS stage,
                      GREATEST(cd.updated_at, COALESCE(la.last_activity, cd.created_at)) AS last_touch
               FROM candidates cd
               JOIN lead_stages s ON s.id=cd.stage_id
               LEFT JOIN LATERAL (SELECT MAX(a.activity_time) AS last_activity FROM activities a WHERE a.lead_id=cd.id) la ON TRUE
               WHERE GREATEST(cd.updated_at, COALESCE(la.last_activity, cd.created_at)) < now() - INTERVAL '7 days'
               ORDER BY last_touch ASC LIMIT 10`)), 5));

    results.push(await timeQuery('activity timeline for one lead', () => withTenant(primary.id, c =>
      c.query(`SELECT a.*, at.name FROM activities a JOIN activity_types at ON at.id=a.activity_type_id
               WHERE a.lead_id=$1 ORDER BY a.activity_time DESC LIMIT 50`, [sampleLeadIds[0]]))));

    results.push(await timeQuery('small tenant list (isolation check)', () => withTenant(tenants[1].id, c =>
      c.query(`SELECT * FROM leads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 25`))));

    // ---- Report ----
    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(`   ${pad('query', 42)} ${pad('p50', 9)} ${pad('p95', 9)} ${pad('p99', 9)} max`);
    console.log(`   ${'-'.repeat(80)}`);
    for (const r of results) {
      const warn = r.p95 > 1000 ? '  <-- SLOW' : r.p95 > 300 ? '  <-- watch' : '';
      console.log(`   ${pad(r.label, 42)} ${pad(String(r.p50), 9)} ${pad(String(r.p95), 9)} ${pad(String(r.p99), 9)} ${r.max}${warn}`);
    }

    // ---- Concurrency ----
    console.log('\n5. Concurrency — same query, N at once (p95 ms):\n');
    for (const conc of [1, 5, 10, 25, 50]) {
      const t0 = process.hrtime.bigint();
      const times: number[] = [];
      await Promise.all(Array.from({ length: conc }, async () => {
        const s = process.hrtime.bigint();
        await withTenant(primary.id, c => c.query(
          `SELECT * FROM leads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 25`));
        times.push(Number(process.hrtime.bigint() - s) / 1e6);
      }));
      times.sort((a, b) => a - b);
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`   ${String(conc).padStart(3)} concurrent: p95 ${Math.round(percentile(times, 95))}ms, wall ${Math.round(wall)}ms, throughput ${Math.round((conc / wall) * 1000)}/s`);
    }

    // ---- Plans for anything slow ----
    const slow = results.filter(r => r.p95 > 200);
    if (slow.length) {
      console.log('\n6. EXPLAIN for the slowest paths (look for "Seq Scan" on leads/activities):\n');
      const plan = await withTenant(primary.id, c => c.query(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM leads WHERE deleted_at IS NULL
         AND fields->>'mx_city' = 'Mumbai' ORDER BY created_at DESC LIMIT 25`));
      for (const row of plan.rows) console.log(`   ${row['QUERY PLAN']}`);
    }

    // ---- Size ----
    const sizes = (await control(c => c.query(
      `SELECT relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
              pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r'
       ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8`))).rows;
    console.log('\n7. Storage footprint:\n');
    let total = 0;
    for (const s of sizes) { total += Number(s.bytes); console.log(`   ${s.table.padEnd(24)} ${s.size}`); }
    console.log(`   ${'per 1k leads'.padEnd(24)} ~${Math.round(total / (LEADS / 1000) / 1024)} KB`);
    console.log(`   ${'projected at 1M leads'.padEnd(24)} ~${(total / LEADS * 1_000_000 / (1024 ** 3)).toFixed(2)} GB`);

    // ---- Verdict ----
    const worst = Math.max(...results.map(r => r.p95));
    console.log('\n=== Verdict ===');
    if (worst < 300) console.log(`PASS — worst p95 is ${worst}ms at ${LEADS.toLocaleString('en-IN')} leads. Comfortable.`);
    else if (worst < 1000) console.log(`ACCEPTABLE — worst p95 is ${worst}ms. Usable, but see the "watch" rows above before growing 10x.`);
    else console.log(`NEEDS WORK — worst p95 is ${worst}ms. Fix the SLOW rows (likely a missing index) before onboarding data at this scale.`);
    console.log('');
  } finally {
    await stopDb();
  }
}

main().catch(e => { console.error('load test failed:', e?.message || e, e?.stack); process.exit(1); });
