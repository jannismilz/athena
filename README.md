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
athena-mcp ---- search --> Wiki.js (keyword) + Postgres (meaning, pgvector)
 |              read ----> Wiki.js
 '------------  write ---> Wiki.js --> athena-indexer --> Postgres
```

Wiki.js is the source of truth. The vector index only helps find things and can
be deleted and rebuilt at any time.

**Contents**

1. [Why](#why)
2. [What runs](#what-runs)
3. [Quickstart](#quickstart)
4. [Authentication, explained](#authentication-explained)
5. [Production deployment](#production-deployment)
6. [The dashboard](#the-dashboard)
7. [Backups](#backups)
8. [Restoring](#restoring)
9. [Connecting an AI](#connecting-an-ai)
10. [Tools](#tools)
11. [Configuration](#configuration)
12. [Operations](#operations)
13. [Development](#development)

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
- **A dashboard with an opinion.** Past the page counts, it lists the searches
  that returned nothing. Each is a page worth writing.

---

## What runs

Seven containers, and only three of them are Athena.

| Service | Port | What it is |
|---|---|---|
| `postgres` | internal | Wiki.js data, Athena's activity log, and the vectors via pgvector |
| `wikijs` | 3000 | The wiki you read and edit |
| `embeddings` | internal | The embedding model, on CPU |
| `mcp` | 8080 | What your AI connects to |
| `indexer` | 8081 | Keeps the vector index in step with the wiki |
| `dashboard` | 8082 | Metrics |
| `backup` | none | Hourly dump, verify, push to rclone |

There is no separate vector database. Vectors live in Postgres, so one backup
covers everything and there is one less service to run.

Every port binds to `127.0.0.1`. Nothing is reachable from outside until you put
a reverse proxy in front of it.

---

## Quickstart

For trying it locally. For anything reachable from the internet, read
[Production deployment](#production-deployment) first.

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

## Authentication, explained

There are exactly **four secrets**, and you generate all of them. No credential
belonging to Claude, OpenAI or anyone else is ever stored in `.env`.

| Secret | Who uses it | What it protects |
|---|---|---|
| `POSTGRES_PASSWORD` | the services | the database |
| `WIKI_API_TOKEN` | mcp, indexer | the Wiki.js API, created inside Wiki.js |
| `MCP_TOKEN` | your AI client | the MCP endpoint |
| `DASHBOARD_TOKEN` | you | the dashboard |

### Why there is an OAuth server, and what it does not do

`MCP_TOKEN` works two ways, because AI clients authenticate two different ways.

**Header clients** such as Cursor and Claude Desktop send
`Authorization: Bearer <MCP_TOKEN>`. That is the whole mechanism.

**Claude.ai in the browser** cannot do that. Its custom connectors only support
OAuth, and the MCP specification requires dynamic client registration, so a
server that accepts browser Claude has to *be* an authorization server. Athena
therefore implements one:

1. Claude registers itself and receives a generated client id. No secret of
   yours is involved.
2. Claude sends you to a login page on your own server.
3. You type `MCP_TOKEN` as the password. That is the human approval step.
4. Athena issues Claude an access token and a refresh token that Athena minted
   itself.

**Those tokens are written to `data/mcp/oauth-state.json`, never to `.env`.**
They are Athena's own tokens, scoped to your server. Revoking them is:

```bash
rm data/mcp/oauth-state.json && docker compose restart mcp
```

Every client then has to connect again. If you never use browser Claude, you can
ignore the whole mechanism; the bearer path does not touch it.

### What is protected, and how

- The MCP endpoint rejects unauthenticated requests with 401 and never explains
  why.
- The login page throttles after 5 wrong passwords per address, and burns a
  login link after 3 attempts.
- The dashboard throttles the same way. It is read-only and never writes.
- Secret comparisons are constant time, so a token cannot be guessed one
  character at a time.
- Both services trust proxy headers only from loopback, so a remote client
  cannot forge its address to escape a throttle.
- Containers run as a non-root user, uid 10001.
- Your Wiki.js token and database password never leave the server. An AI client
  only ever holds a token Athena minted.

### What is deliberately not there

- **No per-tool permissions.** Any authenticated client can use every tool,
  including `delete_page`. Wiki.js keeps page history, so a delete is
  recoverable from the database, but treat `MCP_TOKEN` as full write access to
  your wiki.
- **No multi-user model.** Athena assumes one owner. Wiki.js has its own users
  and permissions for reading the wiki itself.

---

## Production deployment

### 1. Host preparation

A 4 GB VPS runs the whole stack including the embedding model on CPU.

```bash
# Keep only SSH, HTTP and HTTPS open. Postgres and the Athena services must
# never be exposed.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
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

Membership of the `docker` group is equivalent to root on the host, and anyone
in it can read your secrets with `docker inspect`. Keep the group small.

### 2. DNS

Two A records pointing at the host:

| Name | Serves |
|---|---|
| `wiki.example.com` | Wiki.js, and the dashboard under `/dashboard/` |
| `athena-mcp.example.com` | the MCP endpoint your assistant connects to |

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

`MCP_PUBLIC_URL` must be a bare `https://` origin with no path, not `/mcp`. The
server refuses to start otherwise, because a wrong value breaks OAuth discovery
in a way that is hard to diagnose from the client side.

### 4. Reverse proxy and TLS

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

        # MCP streams responses. Without these the connection buffers and long
        # tool calls appear to hang.
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

`X-Forwarded-For` matters: the throttles count failures per address, and without
it every attempt looks like it came from the proxy.

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

# The MCP endpoint must reject unauthenticated calls.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://athena-mcp.example.com/mcp
# expected: 401

# Nothing but 80 and 443 answers from outside.
sudo ss -tlnp | grep -E '3000|8080|8081|8082|5432'
# every line should show 127.0.0.1, never 0.0.0.0
```

---

## The dashboard

A separate service on port 8082, not part of the public site. It answers what a
page count cannot: what the AI actually did, and what your wiki is missing.

```
https://wiki.example.com/dashboard/?token=YOUR_DASHBOARD_TOKEN
```

The token is exchanged for a cookie by an immediate redirect, so it appears in
the URL only once. Prefer a bearer header for scripts:

```bash
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  https://wiki.example.com/dashboard/api/metrics?days=30
```

What it shows:

- **Content**: pages, words, pages per area, the largest pages, and the ones
  going stale.
- **AI activity**: calls per day, which tools get used, which assistant, and the
  read versus write split.
- **Searches that returned nothing**: the most useful list on the page. Each row
  is a question your wiki could not answer.
- **Index health**: chunks stored, pages indexed, how far behind the index is.
- **Backup**: when the last run finished, how big it was, and where it went.

It is read-only and never writes to the wiki.

---

## Backups

**One `pg_dump` is a complete backup.** Wiki.js stores pages, page history,
users, groups, permissions, settings, navigation *and the bytes of every
uploaded file* in Postgres. Uploads live in the `assetData` table as binary
columns; the files under `data/wikijs/uploads` are only a rendering cache.
Athena's activity log and the search vectors live in a second database on the
same server.

| Data | Where it lives | In the backup |
|---|---|---|
| Pages, history, users, settings | Postgres, `wiki` database | yes |
| Uploaded images and files | Postgres, `assetData` table | yes |
| Activity log behind the dashboard | Postgres, `athena` database | yes |
| Search vectors | Postgres, `athena` database | yes |
| Index bookkeeping | `data/indexer` | no, rebuilt automatically |
| OAuth client registrations | `data/mcp` | no, clients reconnect |
| Secrets | `.env` | no, keep a copy in a password manager |

### The backup container

Runs hourly by default. Each run dumps both databases, checks that every dump is
readable, keeps a local copy under `data/backups/archive`, pushes to your rclone
destination, verifies the upload matches, and only then prunes old copies. A
failed run can never delete your last good backup.

Configure it entirely in `.env`:

```bash
BACKUP_ENABLED=true
BACKUP_CRON=0 * * * *
BACKUP_KEEP_LOCAL_DAYS=7
BACKUP_KEEP_REMOTE_DAYS=30

# Where to push. Empty keeps backups on this host only.
BACKUP_REMOTE=s3:my-bucket/athena

RCLONE_CONFIG_S3_TYPE=s3
RCLONE_CONFIG_S3_PROVIDER=AWS
RCLONE_CONFIG_S3_ACCESS_KEY_ID=...
RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=...
RCLONE_CONFIG_S3_REGION=eu-central-1
RCLONE_CONFIG_S3_ENDPOINT=            # set this for B2, Wasabi, MinIO, Hetzner
```

rclone is configured purely from environment variables, so no credentials are
written to a config file anywhere on disk.

To encrypt before anything leaves the host, add a crypt remote and point
`BACKUP_REMOTE` at it. The destination then only ever receives ciphertext,
including the file names:

```bash
BACKUP_REMOTE=crypt:
RCLONE_CONFIG_CRYPT_TYPE=crypt
RCLONE_CONFIG_CRYPT_REMOTE=s3:my-bucket/athena
RCLONE_CONFIG_CRYPT_PASSWORD=<rclone obscure ...>
RCLONE_CONFIG_CRYPT_PASSWORD2=<rclone obscure ...>
```

Keep both crypt passwords in your password manager. Without them the backups are
unreadable, including by you.

### Using it

```bash
# Take one backup now, rather than waiting for the hour
docker compose run --rm backup now

# See what exists, locally and on the remote
docker compose run --rm backup restore list

# Watch the schedule
docker compose logs -f backup
```

The dashboard shows the result of the last run, so a silently broken backup does
not stay invisible.

---

## Restoring

Practise this before you need it. A restore procedure nobody has run is a guess.

```bash
# 1. See what you have
docker compose run --rm backup restore list

# 2. Stop everything that writes, keeping Postgres up
docker compose stop wikijs mcp indexer dashboard

# 3. Restore. It asks you to type the database name to confirm.
docker compose run --rm backup restore run 2026-08-18T115529Z

# 4. Start back up
docker compose start wikijs mcp indexer dashboard
```

To check a backup without restoring it, `restore fetch <stamp>` downloads it and
reports whether each dump is readable.

The search index disagrees with the restored wiki for a moment and then repairs
itself: the indexer re-reads every page and re-embeds anything whose content
changed. To force it immediately:

```bash
docker compose exec -T indexer bun -e 'await fetch("http://127.0.0.1:8081/sync",{method:"POST"})'
```

### Onto a fresh host

```bash
git clone https://github.com/jannismilz/athena.git /srv/athena
cd /srv/athena
cp /path/to/saved/.env .env      # from your password manager
chmod 600 .env
docker compose up -d postgres
docker compose run --rm backup restore run <stamp>
docker compose up -d
```

---

## Connecting an AI

**Claude.ai**, under Settings, Connectors, Add custom connector:

- URL: `https://athena-mcp.example.com/mcp`
- Leave client ID and secret empty. Athena registers the client itself.
- A browser page asks for a password. It is your `MCP_TOKEN`.

**Cursor, Claude Desktop and other header clients**:

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
| `POSTGRES_PASSWORD` | required | |
| `POSTGRES_DB` | `wiki` | The Wiki.js database |
| `ATHENA_DB` | `athena` | Activity log and vectors, created automatically |
| `WIKI_API_TOKEN` | required | Wiki.js, Administration, API |
| `WIKI_LOCALE` | `en` | Content language |
| `WIKI_PUBLIC_URL` | `http://localhost:3000` | Used for dashboard links |
| `MCP_TOKEN` | required | Bearer token and browser login password |
| `MCP_PUBLIC_URL` | required | Bare https origin, no path |
| `DASHBOARD_TOKEN` | required | Protects the dashboard |
| `EMBEDDINGS_MODEL` | `intfloat/multilingual-e5-small` | Changing it re-indexes everything |
| `EMBEDDINGS_PROVIDER` | `tei` | `tei`, or `openai` for a compatible endpoint |
| `INDEX_INTERVAL_SECONDS` | `300` | Full reconciliation interval |
| `CHUNK_MAX_CHARS` | `1200` | Chunk size ceiling |
| `BACKUP_*` | see `.env.example` | Schedule, retention and rclone destination |

Changing `EMBEDDINGS_MODEL` changes the vector width, and vectors from two
models cannot be compared, so the indexer detects it, rebuilds the table, and
re-embeds every page. Wiki.js content is untouched.

---

## Operations

```bash
docker compose logs -f mcp
docker compose logs -f indexer

curl -s localhost:8080/health
curl -s localhost:8081/stats | python3 -m json.tool

# Force a full reconciliation
docker compose exec -T indexer bun -e 'await fetch("http://127.0.0.1:8081/sync",{method:"POST"})'
```

### Upgrading

```bash
cd /srv/athena
docker compose run --rm backup now    # always, before anything else
git pull
docker compose build
docker compose up -d
```

Wiki.js runs its own database migrations on start, and a schema migration is not
reversible by stopping the container, so take the backup first.

### Upgrading Postgres itself

Postgres will not read a data directory written by a different major version. If
you change the `pgvector/pgvector:pgNN` tag on a running install, the container
exits with *database files are incompatible with server*. Dump, wipe, restore:

```bash
docker compose run --rm backup now              # on the OLD version
docker compose down
mv data/postgres data/postgres.old              # keep it until you are happy
# edit the image tag in docker-compose.yml, and the FROM line in
# docker/backup/Dockerfile, to the same new major version
docker compose build backup
docker compose up -d postgres
docker compose run --rm backup restore run <stamp>   # for each database
docker compose up -d
```

The vector index restores with everything else, so no re-embedding is needed.

### If something is wrong

| Symptom | Cause |
|---|---|
| A service exits at boot with a config list | A required variable is missing or still `CHANGE_ME` |
| Claude cannot connect, no login page | `MCP_PUBLIC_URL` has a path, or is not https |
| Login rejects the right password | Throttled after 5 failures, wait a minute |
| Searches return nothing semantic | `embeddings` still downloading, check its logs |
| Dashboard shows pages behind | Indexer catching up, check `docker compose logs indexer` |
| Tool calls fail with 401 | State file cleared or token changed, reconnect the client |
| `pg_restore` complains about parameters | Client and server major versions differ, see the Dockerfile note |
| Postgres exits with "database files are incompatible" | The image major version changed under an existing data directory, see below |

---

## Development

```bash
bun install
bun test          # 131 tests
bun run check     # typecheck, lint, test
```

| Package | What it is |
|---|---|
| `packages/core` | Wiki.js client, chunking, search merge, vectors, config, activity log |
| `packages/mcp` | MCP server, OAuth authorization server, the tools |
| `packages/indexer` | Sync loop, embeddings, vector writes, internal search API |
| `packages/dashboard` | Metrics interface |
| `docker/backup` | Backup and restore container |
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
- The backup image is built from the official Postgres image, so its client
  always matches the server major version. Bump both together.

---

## License

Apache-2.0. See [LICENSE](LICENSE).
