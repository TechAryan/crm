#!/usr/bin/env bash
#
# NexCRM restore drill — restores a dump into a THROWAWAY database and sanity-checks it.
#
# WHY THIS EXISTS: "we have backups" is not the same as "we can restore". Most backup failures
# are only discovered during an actual incident, which is the worst possible time. Run this on a
# schedule (weekly is reasonable) so a broken backup pipeline is found while it's boring.
#
# This never touches production: it restores into a temporary database and drops it afterwards.
#
# Usage:
#   DATABASE_ADMIN_URL=postgres://... ./restore-drill.sh /var/backups/nexcrm/nexcrm-2026....dump
set -euo pipefail

: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"
DUMP="${1:?usage: restore-drill.sh <dumpfile>}"
[[ -f "$DUMP" ]] || { echo "[ERROR] dump not found: $DUMP" >&2; exit 1; }

DRILL_DB="nexcrm_restore_drill_$(date -u +%Y%m%d%H%M%S)"
# Derive an admin connection to the maintenance DB so we can CREATE/DROP DATABASE.
BASE_URL="${DATABASE_ADMIN_URL%/*}"
ADMIN_URL="${BASE_URL}/postgres"

cleanup() {
  echo "[$(date -u +%FT%TZ)] dropping drill database ${DRILL_DB}"
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DRILL_DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[$(date -u +%FT%TZ)] creating drill database ${DRILL_DB}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DRILL_DB};" >/dev/null

echo "[$(date -u +%FT%TZ)] restoring ${DUMP}"
# --exit-on-error so a partial restore is treated as a failure, not a pass.
pg_restore --dbname="${BASE_URL}/${DRILL_DB}" --no-owner --no-privileges --exit-on-error "$DUMP"

echo "[$(date -u +%FT%TZ)] verifying restored data"
CHECKS_FAILED=0
check() {
  local label="$1" sql="$2"
  local out
  out="$(psql "${BASE_URL}/${DRILL_DB}" -tAc "$sql" 2>/dev/null || echo "ERR")"
  if [[ "$out" == "ERR" ]]; then
    echo "  FAIL  ${label}: query failed"; CHECKS_FAILED=$((CHECKS_FAILED+1))
  else
    echo "  ok    ${label}: ${out}"
  fi
}

# Structural checks: the tables that must exist for the app to function at all.
check "tenants table present"        "SELECT count(*) FROM tenants"
check "users table present"          "SELECT count(*) FROM users"
check "leads table present"          "SELECT count(*) FROM leads"
check "migrations recorded"          "SELECT count(*) FROM schema_migrations"
check "RLS enabled on leads"         "SELECT relrowsecurity FROM pg_class WHERE relname='leads'"
check "RLS forced on leads"          "SELECT relforcerowsecurity FROM pg_class WHERE relname='leads'"
check "tenant_isolation policy"      "SELECT count(*) FROM pg_policies WHERE policyname='tenant_isolation'"

if [[ "$CHECKS_FAILED" -gt 0 ]]; then
  echo "[FAIL] restore drill failed ${CHECKS_FAILED} check(s) — the backup is NOT reliable." >&2
  exit 1
fi

echo "[$(date -u +%FT%TZ)] restore drill PASSED — this dump is restorable."
