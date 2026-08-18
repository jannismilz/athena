# Athena

A personal wiki your AI writes to, and you can browse yourself.

Athena puts an MCP server in front of [Wiki.js](https://js.wiki). Your assistant
searches the wiki, reads pages, and files new ones back: notes, documentation,
whole conversations. Everything it writes is an ordinary Markdown page you can
open, edit, and keep long after any particular model is gone.

```
You
 |
 v
Claude / ChatGPT / Cursor
 |  MCP over HTTPS
 v
athena-mcp ---- search --> Wiki.js (keyword) + Qdrant (meaning)
 |              read ----> Wiki.js
 '------------  write ---> Wiki.js --> athena-indexer --> Qdrant
```

Wiki.js is the source of truth. Qdrant only helps find things and can be deleted
and rebuilt at any time.

**Contents**

1. [Why](#why)
2. [Quickstart](#quickstart)
3. [Production deployment](#production-deployment)
4. [Backups](#backups)
5. [Restoring](#restoring)
6. [Connecting an AI](#connecting-an-ai)
7. [Tools](#tools)
8. [Configuration](#configuration)
9. [Operations](#operations)
10. [Development](#development)

---

## Why

A chat assistant forgets everything between conversations, and a wiki nobody
writes to goes stale. Athena joins them. The assistant does the writing, and
what it writes is a real wiki page: browsable, editable, greppable, yours.

- **Two kinds of search.** Exact terms hit the Wiki.js full-text index, vague
  questions hit the vector index, and results are fused with reciprocal rank
  fusion so neither source can bury the other.
- **Structure survives chunking.** A chunk records the headings above it, so
  retrieval keeps its context.
- **Visible provenance.** Every page an assistant touches is stamped with which
  one it was and when, taken from the authenticated client rather than from
  whatever the model claims about itself.
- **Appends, not rewrites.** Adding a fact costs a paragraph instead of
  regenerating the page.
- **A dashboard with an opinion.** Past the page counts, it lists searches that
  returned nothing. Each is a page worth writing.

---

## Quickstart

For trying it locally. For anything reachable from the internet, read
[Production deployment](#production-deployment) first.

Requires Docker and Docker Compose.

```bash
git clone https://github.com/jannismilz/athena.git
cd athena
cp .env.example .env
$EDITOR .env            # fill in every CHANGE_ME
docker compose up -d
```

Generate each secret separately:

```bash
openssl rand -hex 32
```

Then:

1. Open <http://localhost:3000> and complete the Wiki.js setup wizard.
2. In Wiki.js go to **Administration, API**, enable the API, create a token, and
   put it in `.env` as `WIKI_API_TOKEN`.
3. `docker compose up -d` again to pick up the token.
4. Open the dashboard at `http://localhost:8082/?token=YOUR_DASHBOARD_TOKEN`.

The first start downloads an embedding model of a few hundred MB. The indexer
retries until it is ready, so the `embeddings` container looking unhealthy for a
minute or two on first boot is expected.

---

## Production deployment

Athena binds every port to `127.0.0.1`. Nothing is reachable from outside the
host until you put a reverse proxy in front of it, which is deliberate: the MCP
endpoint gives access to everything in your wiki.

### 1. Host preparation

A small VPS is enough. 2 vCPU and 4 GB RAM runs the whole stack including the
embedding model on CPU.

```bash
# Keep only SSH, HTTP and HTTPS open. Postgres, Qdrant and the Athena
# services must never be exposed.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Install Docker from the official repository, then create an unprivileged user
that owns the deployment:

```bash
sudo useradd --create-home --shell /bin/bash athena
sudo usermod -aG docker athena
sudo mkdir -p /srv/athena
sudo chown athena:athena /srv/athena
```

Run everything below as that user. Do not run compose with `sudo`, or the bind
mounts end up owned by root.

### 2. DNS

Two A records pointing at the host:

| Name | Serves |
|---|---|
| `wiki.example.com` | Wiki.js, the interface you read and edit in |
| `athena-mcp.example.com` | the MCP endpoint your assistant connects to |

The dashboard can share the wiki hostname on a path, or take a third name. Both
are covered below.

Check DNS resolves before requesting certificates:

```bash
dig +short wiki.example.com A
dig +short athena-mcp.example.com A
```

### 3. Configuration

```bash
cd /srv/athena
git clone https://github.com/jannismilz/athena.git .
cp .env.example .env
chmod 600 .env          # it holds every secret
```

Set at minimum:

```bash
ATHENA_DATA_DIR=/srv/athena/data
POSTGRES_PASSWORD=<openssl rand -hex 32>
MCP_TOKEN=<openssl rand -hex 32>
DASHBOARD_TOKEN=<openssl rand -hex 32>
MCP_PUBLIC_URL=https://athena-mcp.example.com
WIKI_PUBLIC_URL=https://wiki.example.com
TZ=Europe/Berlin
```

`MCP_PUBLIC_URL` must be a bare `https://` origin with no path. Not `/mcp`. The
server refuses to start otherwise, because a wrong value here breaks OAuth
discovery in a way that is hard to diagnose from the client side.

### 4. Reverse proxy and TLS

Install nginx and certbot on the host, then create the two sites.

```nginx
# /etc/nginx/sites-available/wiki.example.com
server {
    listen 80;
    listen [::]:80;
    server_name wiki.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        client_max_body_size 100M;   # uploads go through here
        proxy_read_timeout 120s;
    }

    # The dashboard, on the same hostname.
    location /dashboard/ {
        proxy_pass http://127.0.0.1:8082/;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```nginx
# /etc/nginx/sites-available/athena-mcp.example.com
server {
    listen 80;
    listen [::]:80;
    server_name athena-mcp.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # MCP streams responses. Without these the connection buffers and
        # long tool calls appear to hang.
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

`X-Real-IP` matters: the login throttle counts failures per address, and without
it every attempt looks like it came from the proxy.

Enable the sites and request certificates:

```bash
sudo ln -sf /etc/nginx/sites-available/wiki.example.com /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/athena-mcp.example.com /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d wiki.example.com -d athena-mcp.example.com \
  --agree-tos --no-eff-email --redirect -m you@example.com

sudo certbot renew --dry-run
```

### 5. Start, and lock down the wiki

```bash
docker compose up -d
docker compose ps
```

Complete the Wiki.js wizard at `https://wiki.example.com` **immediately**. Until
you do, anyone who finds the host can claim the admin account.

Then, in Wiki.js:

- **Administration, Groups, Guests**: remove read access unless you want the
  wiki public. A personal wiki usually should not be.
- **Administration, Auth**: turn off self-registration.
- **Administration, API**: enable it and create the token for `WIKI_API_TOKEN`.

### 6. Verify

```bash
curl -sI https://wiki.example.com | head -1
curl -s  https://athena-mcp.example.com/health
curl -s  https://athena-mcp.example.com/.well-known/oauth-authorization-server | head -c 200

# The MCP endpoint must reject unauthenticated calls.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://athena-mcp.example.com/mcp
# expected: 401

# Nothing but 80 and 443 answers from outside.
sudo ss -tlnp | grep -E '3000|8080|8081|8082|5432|6333'
# every line should show 127.0.0.1, never 0.0.0.0
```

---

## Backups

**One `pg_dump` is a complete backup.** Wiki.js stores pages, page history,
users, groups, permissions, settings, navigation *and the bytes of every
uploaded file* in Postgres. Uploads live in the `assetData` table as binary
columns; the files under `data/wikijs/uploads` are only a rendering cache.
Athena's own activity log lives in a second database on the same server.

So there is nothing to back up outside Postgres:

| Data | Where it lives | In the dump |
|---|---|---|
| Pages, history, users, settings | Postgres, `wiki` database | yes |
| Uploaded images and files | Postgres, `assetData` table | yes |
| Activity log behind the dashboard | Postgres, `athena` database | yes |
| Search vectors | Qdrant | no, and it does not need to be |
| Index bookkeeping | `data/indexer` | no, rebuilt automatically |
| OAuth client registrations | `data/mcp` | no, clients reconnect |
| Secrets | `.env` | no, keep a copy in a password manager |

Qdrant is excluded on purpose. Every vector in it is derived from the wiki, and
the indexer rebuilds the whole collection on its own. Backing it up would cost
space to store something regenerable.

### The backup command

```bash
cd /srv/athena
docker compose exec -T postgres pg_dump -U athena -Fc -d wiki   > wiki.dump
docker compose exec -T postgres pg_dump -U athena -Fc -d athena > athena.dump
```

`-T` is not optional. Without it, Docker allocates a TTY, converts `\n` to
`\r\n` in the stream, and produces a dump file that `pg_restore` cannot read.
The corruption is silent: the file looks like a plausible size and only fails
when you try to restore it, which is the worst possible time to find out.

`-Fc` is the custom format: compressed, and restorable table by table.

### Automating it

A script that dumps, verifies, rotates and reports:

```bash
sudo tee /usr/local/bin/athena-backup >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail

STACK=/srv/athena
DEST=/var/backups/athena
KEEP_DAYS=30
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)

mkdir -p "$DEST"
cd "$STACK"

# A run that dies partway leaves a truncated file behind, and a zero-byte
# .dump looks like a backup in a directory listing. Remove whatever this run
# was writing unless it finished cleanly.
CURRENT=""
cleanup() {
  if [ -n "$CURRENT" ]; then rm -f "$CURRENT"; fi
  return 0   # the trap's status becomes the script's, so never fail here
}
trap cleanup EXIT

for DB in wiki athena; do
  CURRENT="$DEST/${DB}-${STAMP}.dump"
  docker compose exec -T postgres pg_dump -U athena -Fc -d "$DB" > "$CURRENT"

  # A dump that cannot be read is not a backup, so check it now rather than
  # during a restore. pg_restore cannot read a custom-format archive from a
  # pipe, so the file is staged inside the container first.
  if ! docker compose exec -T postgres \
       sh -c 'cat > /tmp/verify.dump && pg_restore --list /tmp/verify.dump >/dev/null; \
              rc=$?; rm -f /tmp/verify.dump; exit $rc' < "$CURRENT"; then
    echo "athena-backup: the $DB dump is unreadable, previous backups are untouched" >&2
    exit 1
  fi

  CURRENT=""   # this one is complete and verified, so keep it
done

# Prune only after every dump succeeded, so a bad run can never delete the
# last good copy.
find "$DEST" -name '*.dump' -mtime +$KEEP_DAYS -delete

echo "athena-backup: ok, $(du -sh "$DEST" | cut -f1) in $DEST"
EOF
sudo chmod +x /usr/local/bin/athena-backup
```

Run it hourly with a systemd timer:

```bash
sudo tee /etc/systemd/system/athena-backup.service >/dev/null <<'EOF'
[Unit]
Description=Athena database backup
After=docker.service

[Service]
Type=oneshot
User=athena
ExecStart=/usr/local/bin/athena-backup
EOF

sudo tee /etc/systemd/system/athena-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Hourly Athena database backup

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now athena-backup.timer

# Check it
sudo systemctl start athena-backup.service
sudo systemctl status athena-backup.service
systemctl list-timers athena-backup.timer
```

### Getting the dumps off the host

A backup on the same disk as the database is not a backup. Copy the directory
somewhere else on a schedule. Any of these work:

```bash
# rclone, to S3, Backblaze, or anything else it supports
rclone sync /var/backups/athena remote:athena-backups

# or restic, which gives deduplication and encryption
restic -r s3:s3.amazonaws.com/my-bucket backup /var/backups/athena
```

Whatever you choose, encrypt it if it leaves your control. The dump contains
every page in your wiki plus password hashes.

### A second, human-readable copy

Optional, and not a substitute for the dump. Wiki.js can mirror page content to
a Git repository continuously: **Administration, Storage, Git**. That gives you
readable Markdown with full history, which is pleasant for diffing and for
reading a page without a running database.

It only covers page content. Users, permissions, settings and uploads are not
included, so keep the `pg_dump` regardless.

### Check your backups exist

```bash
ls -lh /var/backups/athena | tail -5
```

The dashboard shows page and index health but does not watch the host's
filesystem, so this check is on you.

---

## Restoring

Practise this before you need it. A restore procedure nobody has run is a guess.

### Inspect a dump without restoring

`pg_restore` needs to seek within a custom-format archive, so it cannot read one
from a pipe. Stage the file inside the container first:

```bash
docker compose exec -T postgres \
  sh -c 'cat > /tmp/check.dump && pg_restore --list /tmp/check.dump; rm -f /tmp/check.dump' \
  < wiki.dump | head -20
```

A readable dump prints its table of contents. A corrupt one prints
`could not read from input file`. This is the check worth running on a schedule,
because both failure modes above are silent until you try to restore.

### Restore the wiki database

```bash
cd /srv/athena

# 1. Stop everything that writes, but keep Postgres running.
docker compose stop wikijs mcp indexer dashboard

# 2. Restore. --clean --if-exists drops the existing objects first.
docker compose exec -T postgres \
  pg_restore -U athena -d wiki --clean --if-exists --no-owner --no-privileges \
  < wiki.dump

# 3. Start back up.
docker compose start wikijs mcp indexer dashboard
```

The search index will briefly disagree with the restored wiki. It repairs
itself: the indexer re-reads every page and re-embeds anything whose content
changed. To force it immediately:

```bash
docker compose exec -T indexer bun -e 'await fetch("http://127.0.0.1:8081/sync",{method:"POST"})'
```

If the restore moved you back far enough that pages were deleted, also clear the
stale vectors:

```bash
docker compose down indexer
sudo rm -rf data/indexer data/qdrant
docker compose up -d indexer
```

### Restore onto a fresh host

```bash
git clone https://github.com/jannismilz/athena.git /srv/athena
cd /srv/athena
cp /path/to/saved/.env .env      # from your password manager
chmod 600 .env
docker compose up -d postgres
# wait for it to report healthy
docker compose exec -T postgres pg_restore -U athena -d wiki \
  --clean --if-exists --no-owner --no-privileges < wiki.dump
docker compose up -d
```

Qdrant and the indexer state rebuild themselves on first sync.

---

## Connecting an AI

Everything is served from `MCP_PUBLIC_URL`, which must be a bare `https://`
origin with no path.

**Claude.ai**, under Settings, Connectors, Add custom connector:

- URL: `https://athena-mcp.example.com/mcp`
- Leave client ID and secret empty. Athena registers the client itself.
- A browser page asks for a password. It is your `MCP_TOKEN`.

**Cursor and other header-auth clients**, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "athena": {
      "url": "https://athena-mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

Your Wiki.js API token and database credentials never leave the server. A client
only ever holds a token Athena minted.

To revoke a client, delete `data/mcp/oauth-state.json` and restart the MCP
service. Every client then has to connect again.

---

## Tools

| Tool | What it does |
|---|---|
| `search_knowledge` | Keyword and semantic search, fused. Every hit carries a path. |
| `list_pages` | Every page with id, path, title, last update |
| `get_page` | Full Markdown of one page |
| `get_page_structure` | Heading outline, without the body |
| `create_page` | New Markdown page |
| `update_page` | Replace a page body |
| `append_to_page` | Add under a heading, leaving the rest untouched |
| `move_page` | Move or rename |
| `delete_page` | Delete, and drop it from the index |
| `save_conversation` | File a conversation under `conversations/YYYY/MM/` |
| `capture_note` | Quick note into `inbox/` for filing later |
| `get_wiki_stats` | Size, shape and staleness, so the AI can answer what is missing |

`append_to_page` is the one worth knowing about. Adding a fact costs one
paragraph rather than a rewrite of the whole page.

---

## Configuration

Everything comes from the environment. Each service validates its own
configuration at boot and exits with a list of what is wrong, so a typo fails
immediately instead of at three in the morning.

| Variable | Default | Notes |
|---|---|---|
| `ATHENA_DATA_DIR` | `./data` | Root of every bind mount |
| `ATHENA_INSTANCE_NAME` | `Athena` | Shown on the login page and dashboard |
| `ATHENA_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `TZ` | `UTC` | Used for provenance stamps and dated paths |
| `POSTGRES_USER` | `athena` | |
| `POSTGRES_PASSWORD` | required | |
| `POSTGRES_DB` | `wiki` | The Wiki.js database |
| `ATHENA_DB` | `athena` | Activity log, created automatically |
| `WIKI_API_TOKEN` | required | Wiki.js, Administration, API |
| `WIKI_LOCALE` | `en` | Content language |
| `WIKI_PUBLIC_URL` | `http://localhost:3000` | Used for dashboard links |
| `MCP_TOKEN` | required | Bearer token and browser login password |
| `MCP_PUBLIC_URL` | required | Bare https origin, no path |
| `DASHBOARD_TOKEN` | required | Protects the dashboard |
| `EMBEDDINGS_MODEL` | `intfloat/multilingual-e5-small` | Changing it forces a full reindex |
| `EMBEDDINGS_PROVIDER` | `tei` | `tei` or `openai` for any compatible endpoint |
| `EMBEDDINGS_API_KEY` | empty | Only for `openai` |
| `INDEX_INTERVAL_SECONDS` | `300` | Full reconciliation interval |
| `CHUNK_MAX_CHARS` | `1200` | Chunk size ceiling |
| `QDRANT_COLLECTION` | `wiki_chunks` | |

Changing `EMBEDDINGS_MODEL` changes the vector width. Vectors from two models
cannot be compared, so the indexer detects the change, recreates the collection,
and re-embeds everything. Wiki.js content is untouched, but expect one full
rebuild.

---

## Operations

```bash
# Logs
docker compose logs -f mcp
docker compose logs -f indexer

# Health
curl -s localhost:8080/health
curl -s localhost:8081/health
curl -s localhost:8081/stats | python3 -m json.tool

# Force a full reconciliation
docker compose exec -T indexer bun -e 'await fetch("http://127.0.0.1:8081/sync",{method:"POST"})'
```

### Upgrading

```bash
cd /srv/athena
/usr/local/bin/athena-backup     # always, before anything else
git pull
docker compose build
docker compose up -d
docker compose ps
```

Wiki.js runs its own database migrations on start. Take the backup first, since
a schema migration is not reversible by stopping the container.

### If something is wrong

| Symptom | Cause |
|---|---|
| MCP exits at boot with a config list | A required variable is missing or still `CHANGE_ME` |
| Claude cannot connect, no login page | `MCP_PUBLIC_URL` has a path, or is not https |
| Login page rejects the right password | Throttled after 5 failures per address, wait a minute |
| Searches return nothing semantic | `embeddings` still downloading, check its logs |
| Dashboard shows pages behind | Indexer catching up, or check `docker compose logs indexer` |
| Tool calls fail with a 401 | Token revoked or state file cleared, reconnect the client |

---

## Development

```bash
bun install
bun test          # 127 tests
bun run check     # typecheck, lint, test
```

| Package | What it is |
|---|---|
| `packages/core` | Wiki.js client, Markdown chunking, search merge, config, activity log |
| `packages/mcp` | MCP server, OAuth 2.1 authorization server, the tools |
| `packages/indexer` | Sync loop, embeddings, Qdrant, internal search API |
| `packages/dashboard` | Metrics interface |
| `website/` | The one-page site |
| `themes/wikijs/` | Optional Wiki.js CSS and JS for sortable tables and a collapsible outline |

Bun runs TypeScript directly, so there is no build step and the containers run
the source. `bun run --cwd packages/dashboard preview` writes a `preview.html`
with sample data if you are working on the dashboard.

Notes on how it fits together:

- The indexer is incremental. It fingerprints each page and skips anything
  unchanged, so a pass over an untouched wiki costs nothing.
- Every service runs migrations at boot under a Postgres advisory lock, so start
  order does not matter.
- The dashboard is server-rendered HTML with inline SVG charts. No client
  JavaScript, no chart library, no build step.

---

## License

Apache-2.0. See [LICENSE](LICENSE).
