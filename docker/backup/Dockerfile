# Backup sidecar: pg_dump plus rclone, on a container-native scheduler.
#
# Based on the official Postgres image rather than plain Alpine, so the client
# tools are guaranteed to match the server major version. A newer client emits
# settings an older server rejects on restore, and an older client refuses to
# dump a newer server at all. Keep this tag in step with the postgres service
# in docker-compose.yml.
#
# supercronic rather than crond because it logs to stdout and runs as an
# unprivileged user, which is what makes a scheduled job inside a container
# visible through `docker compose logs`.

FROM postgres:18-alpine

ARG SUPERCRONIC_VERSION=v0.2.33
ARG TARGETARCH

RUN apk add --no-cache rclone tzdata ca-certificates curl \
 && case "${TARGETARCH:-amd64}" in \
      arm64) SC_ARCH=arm64 ;; \
      *)     SC_ARCH=amd64 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${SC_ARCH}" \
 && chmod +x /usr/local/bin/supercronic \
 && apk del curl

COPY backup.sh restore.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/entrypoint.sh

# rclone is configured purely from RCLONE_CONFIG_* variables, so point it at an
# empty config to stop it warning about a missing file on every invocation.
ENV RCLONE_CONFIG=/dev/null \
    BACKUP_WORK_DIR=/tmp/athena-backup \
    BACKUP_STATUS_FILE=/backups/status.json \
    BACKUP_LOCAL_DIR=/backups/archive \
    BACKUP_RESTORE_DIR=/backups/restore

# The postgres image already provides an unprivileged `postgres` user.
USER postgres
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
