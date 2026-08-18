#!/bin/sh
# Restore from a backup.
#
#   restore list                  show what is available, locally and remote
#   restore fetch <stamp>         download one backup without restoring it
#   restore run   <stamp>         restore the wiki database from that backup
#
# Practise this before you need it. A restore nobody has run is a guess.
#
# After restoring, the search index disagrees with the wiki for a moment and
# then repairs itself: the indexer re-reads every page and re-embeds anything
# whose content changed.

set -eu

LOCAL_DIR="${BACKUP_LOCAL_DIR:-/backups/archive}"
RESTORE_DIR="${BACKUP_RESTORE_DIR:-/backups/restore}"
REMOTE="${BACKUP_REMOTE:-}"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

[ $# -ge 1 ] || usage 1

case "$1" in
  list)
    printf '\n=== local: %s ===\n' "$LOCAL_DIR"
    find "$LOCAL_DIR" -name '*.dump' -type f -exec basename {} \; 2>/dev/null | sort || echo '(none)'
    if [ -n "$REMOTE" ]; then
      printf '\n=== remote: %s ===\n' "$REMOTE"
      rclone lsf "$REMOTE" --dirs-only 2>/dev/null | sort || echo '(none)'
    else
      printf '\nBACKUP_REMOTE is not set, so there is no remote to list.\n'
    fi
    ;;

  fetch)
    [ $# -eq 2 ] || usage 1
    stamp=$2
    mkdir -p "${RESTORE_DIR}/${stamp}"

    if ls "${LOCAL_DIR}"/*"${stamp}"*.dump >/dev/null 2>&1; then
      echo "found locally"
      cp "${LOCAL_DIR}"/*"${stamp}"*.dump "${RESTORE_DIR}/${stamp}/"
    elif [ -n "$REMOTE" ]; then
      echo "downloading ${REMOTE}/${stamp}"
      rclone copy "${REMOTE}/${stamp}" "${RESTORE_DIR}/${stamp}" --progress \
        || { echo "no backup found for ${stamp}" >&2; exit 1; }
    else
      echo "no local copy and no remote configured" >&2
      exit 1
    fi

    ls -la "${RESTORE_DIR}/${stamp}"
    for f in "${RESTORE_DIR}/${stamp}"/*.dump; do
      printf '%s: ' "$(basename "$f")"
      pg_restore --list "$f" >/dev/null 2>&1 && echo "readable" || echo "CORRUPT"
    done
    ;;

  run)
    [ $# -eq 2 ] || usage 1
    stamp=$2
    "$0" fetch "$stamp"

    DB="${POSTGRES_DB:-wiki}"
    dump=$(find "${RESTORE_DIR}/${stamp}" -name "${DB}-*.dump" | head -n 1)
    [ -n "$dump" ] || { echo "no ${DB} dump inside ${stamp}" >&2; exit 1; }

    : "${POSTGRES_HOST:?POSTGRES_HOST is required}"
    : "${POSTGRES_USER:?POSTGRES_USER is required}"

    cat <<WARN

About to restore
  ${dump}
into database ${DB} on ${POSTGRES_HOST}.

This DROPS and recreates every object in that database. Stop the wikijs
container first, or it will write into a half-restored schema:

  docker compose stop wikijs mcp indexer dashboard

WARN
    printf 'Type the database name to confirm: '
    read -r confirm
    [ "$confirm" = "$DB" ] || { echo "aborted"; exit 1; }

    PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_restore \
      --host="$POSTGRES_HOST" \
      --port="${POSTGRES_PORT:-5432}" \
      --username="$POSTGRES_USER" \
      --dbname="$DB" \
      --clean --if-exists --no-owner --no-privileges \
      "$dump"

    cat <<'DONE'

Restored. Start the rest of the stack again:

  docker compose start wikijs mcp indexer dashboard

The indexer rebuilds search on its next pass. Nothing else needs restoring.
DONE
    ;;

  *) usage 1 ;;
esac
