#!/bin/sh
# Build the schedule from the environment and hand over to supercronic.
#
#   docker compose run --rm backup now              take one backup and exit
#   docker compose run --rm backup restore list     see what is available
#   docker compose run --rm backup restore run <s>  restore that backup

set -eu

case "${1:-}" in
  now)     shift; exec /usr/local/bin/backup.sh "$@" ;;
  restore) shift; exec /usr/local/bin/restore.sh "$@" ;;
esac

if [ "${BACKUP_ENABLED:-true}" != "true" ]; then
  echo "backup: disabled by BACKUP_ENABLED, idling"
  while true; do sleep 3600; done
fi

# Fail at start rather than at 03:00 on a Sunday.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "backup: checking the remote is reachable"
  rclone lsd "${BACKUP_REMOTE}" >/dev/null 2>&1 \
    || rclone mkdir "${BACKUP_REMOTE}" \
    || { echo "backup: cannot reach or write to ${BACKUP_REMOTE}, check the rclone settings" >&2; exit 1; }
  echo "backup: remote is reachable"
else
  echo "backup: BACKUP_REMOTE is empty, backups stay on this host only"
fi

CRON="${BACKUP_CRON:-0 * * * *}"
echo "${CRON} /usr/local/bin/backup.sh" > /tmp/crontab
echo "backup: schedule is '${CRON}'"

# Absolute path matters: as PID 1 supercronic re-executes argv[0] to enable
# process reaping, and a bare name is not resolved against PATH.
exec /usr/local/bin/supercronic -passthrough-logs /tmp/crontab
