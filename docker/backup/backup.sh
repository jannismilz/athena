#!/bin/sh
# Take a backup and push it to the configured rclone remote.
#
# One pg_dump per database is a complete backup. Wiki.js keeps pages, history,
# users, permissions, settings and the bytes of every uploaded file in Postgres,
# and Athena keeps its activity log and the search vectors there too. There is
# nothing on disk that a dump does not already contain.
#
# Everything is encrypted before it leaves the host when a crypt remote is
# configured, so the destination only ever holds ciphertext.

set -eu

WORK="${BACKUP_WORK_DIR:-/tmp/athena-backup}"
STATUS="${BACKUP_STATUS_FILE:-/backups/status.json}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/backups/archive}"
REMOTE="${BACKUP_REMOTE:-}"
KEEP_LOCAL_DAYS="${BACKUP_KEEP_LOCAL_DAYS:-7}"
KEEP_REMOTE_DAYS="${BACKUP_KEEP_REMOTE_DAYS:-30}"

STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
STARTED=$(date -u +%s)
BYTES=0
REASON=""

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

write_status() {
  ok=$1
  reason=$2
  mkdir -p "$(dirname "$STATUS")"
  tmp="${STATUS}.tmp"
  cat > "$tmp" <<EOF
{
  "ok": ${ok},
  "finished_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_seconds": $(( $(date -u +%s) - STARTED )),
  "bytes": ${BYTES},
  "destination": "$( [ -n "$REMOTE" ] && echo "$REMOTE" || echo "$LOCAL_DIR" )",
  "error": $( [ -z "$reason" ] && echo null || printf '"%s"' "$reason" )
}
EOF
  mv "$tmp" "$STATUS"
}

on_exit() {
  code=$?
  # A half-written dump must never be left looking like a good backup.
  rm -rf "$WORK"
  if [ "$code" -eq 0 ] && [ -z "$REASON" ]; then
    write_status true ""
    log "done in $(( $(date -u +%s) - STARTED ))s"
  else
    write_status false "${REASON:-exited with code $code}"
    log "FAILED: ${REASON:-exit $code}"
  fi
  exit "$code"
}
trap on_exit EXIT

fail() { REASON="$1"; exit 1; }

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

rm -rf "$WORK"
mkdir -p "$WORK" "$LOCAL_DIR"

# ── Dump ───────────────────────────────────────────────────────────────────
# -Fc is the custom format: compressed, and restorable table by table.
for DB in "${POSTGRES_DB:-wiki}" "${ATHENA_DB:-athena}"; do
  [ -n "$DB" ] || continue
  log "dumping ${DB}"
  OUT="${WORK}/${DB}-${STAMP}.dump"

  PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump \
    --host="$POSTGRES_HOST" \
    --port="${POSTGRES_PORT:-5432}" \
    --username="$POSTGRES_USER" \
    --dbname="$DB" \
    --format=custom \
    --compress=6 \
    --file="$OUT" || fail "pg_dump of ${DB} failed"

  # A dump that cannot be read is not a backup. Check now, not during a
  # restore at the worst possible moment.
  pg_restore --list "$OUT" > /dev/null 2>&1 || fail "the ${DB} dump is unreadable"
  log "  $(du -h "$OUT" | cut -f1)"
done

BYTES=$(du -sb "$WORK" 2>/dev/null | cut -f1 || echo 0)

# ── Keep a copy on disk ────────────────────────────────────────────────────
cp "$WORK"/*.dump "$LOCAL_DIR"/ || fail "could not write to ${LOCAL_DIR}"

# ── Push to the remote ─────────────────────────────────────────────────────
if [ -n "$REMOTE" ]; then
  DEST="${REMOTE}/${STAMP}"
  log "uploading to ${DEST}"
  rclone copy "$WORK" "$DEST" \
    --transfers=2 --checkers=4 --retries=3 --low-level-retries=10 \
    --stats-one-line --stats=30s || fail "upload failed"

  # Verify rather than assume. Without this, an upload that silently truncated
  # would still be reported as a success.
  rclone check "$WORK" "$DEST" --one-way || fail "verification failed, the remote does not match"
  log "verified"
else
  log "BACKUP_REMOTE is not set, keeping local copies only"
fi

# ── Retention ──────────────────────────────────────────────────────────────
# Pruning runs only after a verified upload, so a failed run can never delete
# the last good copy.
find "$LOCAL_DIR" -name '*.dump' -mtime "+${KEEP_LOCAL_DAYS}" -delete 2>/dev/null || true

if [ -n "$REMOTE" ]; then
  log "pruning backups older than ${KEEP_REMOTE_DAYS}d"
  # Delete the expired files first, then sweep up the directories they leave
  # behind. Combining the two makes rclone try to remove the directory this
  # run just created, which fails noisily and means nothing.
  rclone delete "$REMOTE" --min-age "${KEEP_REMOTE_DAYS}d" || log "warning: remote prune failed"
  rclone rmdirs "$REMOTE" --leave-root 2>/dev/null || true
fi
