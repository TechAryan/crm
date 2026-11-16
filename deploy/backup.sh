#!/usr/bin/env bash
#
# NexCRM Postgres backup.
#
# WHY A SCRIPT AND NOT JUST MANAGED SNAPSHOTS: managed snapshots are the right primary defence,
# but they're bound to the provider and the instance. A logical dump that you can restore
# anywhere protects you from the failure modes snapshots don't cover — a bad migration, an
# accidental mass delete, or losing access to the account itself.
#
# Run from cron/a scheduled task, e.g. hourly:
#   0 * * * * /opt/nexcrm/deploy/backup.sh >> /var/log/nexcrm-backup.log 2>&1
#
# Required env:
#   DATABASE_ADMIN_URL   postgres://user:pass@host:5432/nexcrm
#   BACKUP_DIR           local directory for dumps (default /var/backups/nexcrm)
# Optional:
#   S3_BUCKET            if set, dumps are uploaded (offsite copy) and pruned locally
#   RETENTION_DAYS       local retention, default 7
#   GPG_RECIPIENT        if set, the dump is encrypted before upload
set -euo pipefail

: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/nexcrm}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_DIR}/nexcrm-${TS}.dump"

mkdir -p "$BACKUP_DIR"

echo "[$(date -u +%FT%TZ)] starting backup -> ${FILE}"

# -Fc = custom format: compressed, and restorable selectively (single table if needed).
pg_dump --dbname="$DATABASE_ADMIN_URL" --format=custom --no-owner --no-privileges --file="$FILE"

SIZE="$(du -h "$FILE" | cut -f1)"
echo "[$(date -u +%FT%TZ)] dump complete (${SIZE})"

# Verify the dump is readable before trusting it. An unverified backup is not a backup —
# a truncated or corrupt file that nobody checked is the classic disaster-recovery failure.
if ! pg_restore --list "$FILE" > /dev/null 2>&1; then
  echo "[ERROR] dump failed verification (pg_restore --list could not read it). NOT pruning old backups." >&2
  exit 1
fi
echo "[$(date -u +%FT%TZ)] dump verified readable"

UPLOAD="$FILE"
if [[ -n "${GPG_RECIPIENT:-}" ]]; then
  gpg --yes --batch --encrypt --recipient "$GPG_RECIPIENT" --output "${FILE}.gpg" "$FILE"
  UPLOAD="${FILE}.gpg"
  echo "[$(date -u +%FT%TZ)] encrypted -> ${UPLOAD}"
fi

if [[ -n "${S3_BUCKET:-}" ]]; then
  aws s3 cp "$UPLOAD" "s3://${S3_BUCKET}/postgres/$(basename "$UPLOAD")" --only-show-errors
  echo "[$(date -u +%FT%TZ)] uploaded to s3://${S3_BUCKET}/postgres/"
fi

# Prune only after a verified (and, if configured, uploaded) backup.
find "$BACKUP_DIR" -name 'nexcrm-*.dump*' -type f -mtime "+${RETENTION_DAYS}" -delete
echo "[$(date -u +%FT%TZ)] pruned local backups older than ${RETENTION_DAYS} days"
echo "[$(date -u +%FT%TZ)] backup finished OK"
