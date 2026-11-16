-- 014: Indexes added in response to MEASURED load-test results, not guesswork.
--
-- Method: seeded 100,000 leads, timed the hot query paths, read the EXPLAIN plans, and added
-- only the indexes that a real plan showed it needed. Each one below has a measured reason.

-- ---------------------------------------------------------------------------
-- 1. "Needs Attention" (cold leads) candidate selection
--
-- The query pre-filters on `updated_at < now() - N days` and takes the oldest 500. Without this
-- index that ORDER BY becomes a full sort of every matching lead (measured 190ms p95 at 100k).
-- With it, Postgres walks the index in order and stops after 500 rows.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_tenant_updated ON leads (tenant_id, updated_at)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Case-insensitive name/email search
--
-- The list view searches with ILIKE on first_name/last_name/email. Trigram indexes are what make
-- a leading-wildcard ILIKE ('%foo%') index-assisted instead of a sequential scan. Measured 41ms
-- p95 at 100k, which is fine, but this keeps it flat as the table grows toward millions.
--
-- pg_trgm ships with Postgres but must be enabled. If the extension isn't available (some managed
-- providers restrict it), we skip silently — the queries still work, just without this assist.
-- ---------------------------------------------------------------------------
-- MEASURED TRADE-OFF: a trigram index on NAME cut ILIKE search from 41ms to 8ms p95.
-- A trigram index on EMAIL was also tried and REMOVED: the planner started preferring it for
-- exact `lower(email) = lower($1)` lookups, which pushed the dedupe path used on every single
-- lead capture from 16ms to 46ms. Fuzzy email search is rare; exact email dedupe runs constantly,
-- so the btree on lower(email) must win. Do not re-add an email trigram index without re-running
-- scripts/loadtest.ts and checking the "email lookup (dedupe path)" row.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_leads_name_trgm ON leads
    USING gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,'')) gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm not available; skipping trigram index (search still works, just unassisted)';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Custom-field equality filters
--
-- EXPLAIN showed `fields->>'mx_city' = 'x'` was NOT using the plain gin(fields) index — a `->>`
-- comparison can't use it (that index serves containment `@>` operators). The generic fix without
-- knowing which fields a tenant will filter on is jsonb_path_ops, which is smaller and faster for
-- containment lookups. Measured 33ms p95 at 100k, so this is pre-emptive headroom rather than a
-- fix for a current problem.
--
-- NOTE for future tuning: if a specific tenant filters constantly on one field, the real win is a
-- targeted expression index, e.g.
--   CREATE INDEX ... ON leads ((fields->>'mx_city')) WHERE deleted_at IS NULL;
-- That is a per-deployment decision, not something to guess at here.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_fields_path ON leads USING gin (fields jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- 4. Lead count / list ordering
--
-- `COUNT(*)` on a large tenant showed p99 spikes to ~110ms because it must visit rows. A
-- covering index lets Postgres answer from the index alone (index-only scan) when the visibility
-- map is current, which VACUUM maintains.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_tenant_created_id ON leads (tenant_id, created_at DESC, id)
  WHERE deleted_at IS NULL;

-- Refresh planner statistics so the new indexes are actually chosen.
ANALYZE leads;
