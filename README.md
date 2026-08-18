# Athena

**A personal wiki your AI writes to, and you can browse yourself.**

Athena puts an MCP server in front of [Wiki.js](https://js.wiki). Your assistant
searches the wiki, reads pages, and files new ones back: notes, documentation,
whole conversations. Everything it writes is an ordinary Markdown page you can
open, edit, and keep long after any particular model is gone.

```
Claude / ChatGPT / Cursor
        │  MCP over HTTPS
        ▼
   athena-mcp ──── search ──▶ Wiki.js (keyword) + Postgres (meaning)
        │          read ────▶ Wiki.js
        └────────  write ───▶ Wiki.js ──▶ athena-indexer ──▶ Postgres
```

Wiki.js holds the truth. The vector index only helps find things, and can be
deleted and rebuilt at any time.

| | |
|---|---|
| **Get running** | [Quickstart](#quickstart) · [Connect your AI](#connect-your-ai) |
| **Use it** | [Tools](#tools) · [Dashboard](#dashboard) |
| **Run it for real** | [Deploy to a server](#deploy-to-a-server) · [Backups](#backups) |
| **Reference** | [Configuration](#configuration) · [Security](#security) · [Operations](#operations) · [Development](#development) |

---

## Quickstart

Local, in about five minutes. For anything on the internet, read
[Deploy to a server](#deploy-to-a-server) first.

```bash
git clone https://github.com/jannismilz/athena.git
cd athena
cp .env.example .env
$EDITOR .env          # fill in every CHANGE_ME, one per secret:
                      #   openssl rand -hex 32
docker compose up -d
```

Then:

1. Open Wiki.js and complete the setup wizard.
2. In Wiki.js: **Administration → API**, enable it, create a token, and put it
   in `.env` as `WIKI_API_TOKEN`.
3. `docker compose up -d` again to pick it up.
4. Open the dashboard and sign in with `DASHBOARD_TOKEN`.

Nothing publishes a port, so reach the services through your reverse proxy, or
add a temporary `ports:` mapping while trying it out.

The first start downloads an embedding model of a few hundred MB. The indexer
retries until it is ready, so `embeddings` looking unhealthy for a minute or two
on first boot is expected.

---

## Connect your AI

Everything is served from `MCP_PUBLIC_URL`, which must be a bare `https://`
origin with **no path**. Not `/mcp`.

**Claude.ai** → Settings → Connectors → Add custom connector

- URL: `https://athena-mcp.example.com/mcp`
- Leave client ID and secret empty. Athena registers the client itself.
- A browser page asks for a password. It is your `MCP_TOKEN`.

**Cursor, Claude Desktop, and other header clients**

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
| `get_page` | Full Markdown of one page |
| `get_page_structure` | Heading outline, without the body |
| `append_to_page` | Add under a heading, leaving the rest untouched |
| `create_page` | New Markdown page |
| `update_page` | Replace a page body |
| `move_page` | Move or rename |
| `delete_page` | Delete, and drop it from the index |
| `save_conversation` | File a conversation under `conversations/YYYY/MM/` |
| `capture_note` | Quick note into `inbox/` for filing later |
| `list_pages` | Everything, with paths and timestamps |
| `get_wiki_stats` | Size, shape and staleness, so the AI can answer what is missing |

`append_to_page` is the one worth knowing about: adding a fact costs a
paragraph, not a rewrite of the whole page.

**Why it retrieves well.** Exact terms hit the Wiki.js full-text index, vague
questions hit the vector index, and results are fused with reciprocal rank
fusion so neither source can bury the other. Chunks record the headings above
them, so what comes back keeps its context. Every page an assistant touches is
stamped with which one it was and when, taken from the authenticated client
rather than from what the model claims about itself.

---

## Dashboard

Its own service, on port 8082. Sign in with `DASHBOARD_TOKEN`; there is no token
in any URL. For scripts, use a bearer header:

```bash
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  https://wiki.example.com/dashboard/api/metrics?days=30
```

| Panel | Answers |
|---|---|
| Content | pages, words, per area, largest, going stale |
| AI activity | calls per day, which tools, which assistant, read vs write |
| **Searches that found nothing** | what your wiki could not answer |
| Index health | chunks stored, pages indexed, how far behind |
| Backup | when the last run finished, how big, where it went |

The third row is the one that earns its place. Every entry is a page worth
writing.

It is read-only twice over: it never writes, and it connects to Postgres as
`athena_readonly`, a role holding SELECT and nothing else. Figures are
aggregated in Postgres and cached, so a refresh costs almost nothing.

---

## Deploy to a server

A 4 GB VPS runs everything, including the embedding model on CPU.

### 1. Host and firewall

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

Install Docker, then create a user that owns the deployment:

```bash
sudo useradd --create-home --shell /bin/bash athena
sudo usermod -aG docker athena
```

Run compose as that user, never with `sudo`, or the bind mounts end up owned by
root. Membership of the `docker` group is equivalent to root on the host, so
keep it small.

### 2. DNS

Two A records pointing at the host:

| Name | Serves |
|---|---|
| `wiki.example.com` | Wiki.js, and the dashboard under `/dashboard/` |
| `athena-mcp.example.com` | the MCP endpoint |

### 3. Lay it out and configure

Everything Athena writes goes through one setting, `ATHENA_DATA_DIR`, so the
whole installation can live under a single directory. Use two subdirectories
with different lifecycles:

```
/athena
├── app/     the git repository   replaceable, thrown away on every upgrade
└── data/    postgres, state,     irreplaceable, never touched by git
             uploads, backups
```

**Do not put the data inside the repository.** `data/` is in `.gitignore`, and
`git clean -xdf` deletes ignored files, so one routine command wipes your
database with no confirmation and no undo. Keeping them as siblings makes that
impossible.

```bash
sudo mkdir -p /athena && sudo chown athena:athena /athena
cd /athena
git clone https://github.com/jannismilz/athena.git app
cd app
cp .env.example .env
chmod 600 .env        # it holds every secret
```

Set at minimum:

```bash
ATHENA_DATA_DIR=/athena/data
POSTGRES_PASSWORD=...
MCP_TOKEN=...
DASHBOARD_TOKEN=...
DASHBOARD_DB_PASSWORD=...
MCP_PUBLIC_URL=https://athena-mcp.example.com
WIKI_PUBLIC_URL=https://wiki.example.com
```

Compose creates `/athena/data` and its subdirectories on first start. Run every
`docker compose` command from `/athena/app`.

<details>
<summary><b>What ends up where</b></summary>

```
/athena/data
├── postgres/     the wiki, users, settings, uploads, activity log, vectors
├── wikijs/       Wiki.js config, cache, upload cache
├── mcp/          oauth-state.json, the tokens issued to AI clients
├── indexer/      index bookkeeping, rebuilt automatically if lost
├── embeddings/   the downloaded model
└── backups/      local dumps plus status.json
```

Only `postgres/` is irreplaceable, and the backup container dumps it hourly.
Everything else is either regenerated automatically or costs one reconnection.

If you would rather follow the filesystem hierarchy convention, put the data in
`/srv/athena` and the checkout in `/opt/athena` instead. The single-root layout
above is simpler on a machine that does one job, and either works: only
`ATHENA_DATA_DIR` decides.

</details>

### 4. Reverse proxy

No container publishes a port. Everything lives on the `athena` Docker network,
which your proxy joins. Route these:

| Host | To | Notes |
|---|---|---|
| `wiki.example.com` | `wikijs:3000` | WebSocket upgrade, 100M body limit |
| `wiki.example.com/dashboard/` | `dashboard:8082` | |
| `athena-mcp.example.com` | `mcp:8080` | **must not buffer**, MCP streams |

Forward `X-Forwarded-For`: the logins throttle per address, and without it every
attempt looks like it came from the proxy.

<details>
<summary><b>Worked nginx example</b></summary>

Run nginx as a container joined to the `athena` network, as below, or on the
host with a `ports:` mapping bound to `127.0.0.1`.

```nginx
server {
    listen 80;
    server_name wiki.example.com;

    location / {
        proxy_pass http://wikijs:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        client_max_body_size 100M;
        proxy_read_timeout 120s;
    }

    location /dashboard/ {
        proxy_pass http://dashboard:8082/;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name athena-mcp.example.com;

    location / {
        proxy_pass http://mcp:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # MCP streams responses. Without these, long tool calls appear to hang.
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

Then issue certificates with certbot, or terminate TLS wherever you already do.

</details>

### 5. Start, then lock the wiki down

```bash
docker compose up -d && docker compose ps
```

Complete the Wiki.js wizard **immediately**. Until you do, anyone who finds the
host can claim the admin account. Then, in Wiki.js:

- **Groups → Guests**: remove read access, unless you want the wiki public.
- **Auth**: turn off self-registration.
- **API**: enable it and create the token for `WIKI_API_TOKEN`.

### 6. Verify

```bash
curl -s https://athena-mcp.example.com/health

# Must reject unauthenticated calls:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://athena-mcp.example.com/mcp
# expected: 401
```

---

## Backups

**One `pg_dump` is a complete backup.** Wiki.js keeps pages, history, users,
permissions, settings *and the bytes of every uploaded file* in Postgres.
Uploads live in the `assetData` table; the files under `data/wikijs/uploads` are
only a cache. Athena's activity log and search vectors are in a second database
on the same server.

| Data | In the backup |
|---|---|
| Pages, history, users, settings | yes |
| Uploaded images and files | yes |
| Activity log and search vectors | yes |
| Index bookkeeping, OAuth registrations | no, rebuilt or reconnected |
| `.env` | no, keep a copy in a password manager |

The `backup` container runs hourly. Each run dumps both databases, checks every
dump is readable, keeps a local copy, pushes to your rclone destination,
verifies the upload matches, and only then prunes. A failed run can never delete
your last good backup.

```bash
docker compose run --rm backup now            # take one now
docker compose run --rm backup restore list   # see what exists
docker compose logs -f backup                 # watch the schedule
```

Configure it entirely in `.env`. Any rclone destination works: S3, Backblaze,
Wasabi, MinIO, Hetzner. Leave `BACKUP_REMOTE` empty to keep backups on the host
only.

<details>
<summary><b>Encrypting backups before they leave the host</b></summary>

Add a crypt remote and point `BACKUP_REMOTE` at it. The destination then only
ever receives ciphertext, including file names.

```bash
BACKUP_REMOTE=crypt:
RCLONE_CONFIG_CRYPT_TYPE=crypt
RCLONE_CONFIG_CRYPT_REMOTE=s3:my-bucket/athena
RCLONE_CONFIG_CRYPT_PASSWORD=<rclone obscure ...>
RCLONE_CONFIG_CRYPT_PASSWORD2=<rclone obscure ...>
```

Keep both passwords in your password manager. Without them the backups are
unreadable, including by you.

</details>

### Restoring

Practise this before you need it. A restore nobody has run is a guess.

```bash
docker compose run --rm backup restore list
docker compose stop wikijs mcp indexer dashboard
docker compose run --rm backup restore run 2026-08-18T115529Z
docker compose start wikijs mcp indexer dashboard
```

It asks you to type the database name to confirm. `restore fetch <stamp>`
downloads a backup without restoring it, and reports whether each dump is
readable.

The search index repairs itself afterwards: the indexer re-reads every page and
re-embeds anything whose content changed.

---

## Configuration

Everything comes from the environment. Each service validates its own
configuration at boot and exits with a list of what is wrong, so a typo fails
immediately rather than at three in the morning.

**The five secrets**, all generated by you. No credential belonging to Claude,
OpenAI or anyone else is ever stored in `.env`.

| Secret | Held by | Protects |
|---|---|---|
| `POSTGRES_PASSWORD` | postgres, mcp, indexer | full database access |
| `WIKI_API_TOKEN` | mcp, indexer | the Wiki.js API |
| `MCP_TOKEN` | mcp | the MCP endpoint |
| `DASHBOARD_TOKEN` | dashboard | the dashboard sign-in |
| `DASHBOARD_DB_PASSWORD` | dashboard, mcp, indexer | a SELECT-only database role |

### What runs

| Service | Port | What it is |
|---|---|---|
| `postgres` | internal | Wiki.js data, activity log, and vectors via pgvector |
| `wikijs` | 3000 | The wiki you read and edit |
| `embeddings` | internal | The embedding model, on CPU |
| `mcp` | 8080 | What your AI connects to |
| `indexer` | 8081 | Keeps the vector index in step with the wiki |
| `dashboard` | 8082 | Metrics |
| `backup` | none | Hourly dump, verify, push |

There is no separate vector database. Vectors live in Postgres, so one backup
covers everything.

> **On ARM hosts** the embeddings image is published for `linux/amd64` only and
> will not run natively. Point `EMBEDDINGS_PROVIDER=openai` at an
> OpenAI-compatible endpoint such as Ollama instead.

<details>
<summary><b>Every other setting</b></summary>

| Variable | Default | Notes |
|---|---|---|
| `ATHENA_DATA_DIR` | `./data` | Root of every bind mount |
| `ATHENA_INSTANCE_NAME` | `Athena` | Shown on the login page and dashboard |
| `ATHENA_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `TZ` | `UTC` | Provenance stamps and dated paths |
| `POSTGRES_DB` | `wiki` | The Wiki.js database |
| `ATHENA_DB` | `athena` | Activity log and vectors, created automatically |
| `WIKI_LOCALE` | `en` | Content language |
| `WIKI_PUBLIC_URL` | `http://localhost:3000` | Used for dashboard links |
| `MCP_PUBLIC_URL` | required | Bare https origin, no path |
| `METRICS_CACHE_SECONDS` | `60` | How long dashboard figures are reused |
| `EMBEDDINGS_MODEL` | `intfloat/multilingual-e5-small` | Changing it re-indexes everything |
| `EMBEDDINGS_PROVIDER` | `tei` | `tei`, or `openai` for a compatible endpoint |
| `INDEX_INTERVAL_SECONDS` | `300` | Full reconciliation interval |
| `CHUNK_MAX_CHARS` | `1200` | Chunk size ceiling |
| `BACKUP_*` | see `.env.example` | Schedule, retention, rclone destination |

Changing `EMBEDDINGS_MODEL` changes the vector width, and vectors from two
models cannot be compared, so the indexer rebuilds the table and re-embeds every
page. Wiki.js content is untouched.

</details>

---

## Security

Each container receives only the credentials it uses. The dashboard gets neither
`POSTGRES_PASSWORD` nor `WIKI_API_TOKEN`, so compromising it yields read access
and nothing more. Check at any time:

```bash
docker inspect athena-dashboard -f '{{range .Config.Env}}{{println .}}{{end}}' | grep -iE 'PASSWORD|TOKEN'
```

- Unauthenticated MCP requests get 401 and no explanation.
- Both login paths throttle after 5 failures per address; a login link burns
  after 3 attempts.
- Dashboard sessions are signed cookies carrying an expiry and a nonce, never
  the token. `HttpOnly`, `SameSite=Strict`, and cross-site posts are refused.
- Secret comparisons are constant time.
- Proxy headers are trusted only from loopback, so a remote client cannot forge
  its address to escape a throttle.
- Containers run as a non-root user.

**Deliberately absent:** per-tool permissions. Any authenticated client can call
every tool, including `delete_page`. Wiki.js keeps page history so a delete is
recoverable, but treat `MCP_TOKEN` as full write access to your wiki. Athena
also assumes a single owner; Wiki.js has its own users for reading the wiki.

<details>
<summary><b>Why there is an OAuth server, and what it is not</b></summary>

`MCP_TOKEN` works two ways, because AI clients authenticate two ways.

**Header clients** such as Cursor and Claude Desktop send
`Authorization: Bearer <MCP_TOKEN>`. That is the whole mechanism.

**Claude.ai in the browser** cannot do that. Its custom connectors only support
OAuth, and the MCP specification requires dynamic client registration, so a
server that accepts browser Claude has to *be* an authorization server. Athena
implements one:

1. Claude registers itself and receives a generated client id. No secret of
   yours is involved.
2. Claude sends you to a login page on your own server.
3. You type `MCP_TOKEN` as the password. That is the human approval step.
4. Athena issues Claude tokens that Athena minted itself.

Those tokens are written to `data/mcp/oauth-state.json`, **never to `.env`**.
Revoke them with:

```bash
rm data/mcp/oauth-state.json && docker compose restart mcp
```

If you never use browser Claude, ignore all of this. The bearer path does not
touch it.

</details>

---

## Operations

```bash
docker compose logs -f mcp
curl -s localhost:8081/stats | python3 -m json.tool

# Force a full reconciliation
docker compose exec -T indexer bun -e 'await fetch("http://127.0.0.1:8081/sync",{method:"POST"})'
```

**Upgrading.** Always back up first: Wiki.js runs its own migrations on start,
and those are not reversible by stopping the container.

```bash
docker compose run --rm backup now
git pull && docker compose build && docker compose up -d
```

<details>
<summary><b>Troubleshooting</b></summary>

| Symptom | Cause |
|---|---|
| A service exits at boot listing config | A required variable is missing or still `CHANGE_ME` |
| Claude cannot connect, no login page | `MCP_PUBLIC_URL` has a path, or is not https |
| Login rejects the right password | Throttled after 5 failures, wait a minute |
| No semantic search results | `embeddings` still downloading, check its logs |
| Dashboard shows pages behind | Indexer catching up, check its logs |
| Tool calls fail with 401 | State file cleared or token changed, reconnect the client |
| Postgres exits, "database files are incompatible" | The image major version changed under existing data |

</details>

<details>
<summary><b>Upgrading Postgres to a new major version</b></summary>

Postgres will not read a data directory written by a different major version.
Dump, wipe, restore:

```bash
docker compose run --rm backup now             # on the OLD version
docker compose down
mv data/postgres data/postgres.old             # keep until you are happy
# edit the image tag in docker-compose.yml and the FROM line in
# docker/backup/Dockerfile to the same new major version
docker compose build backup
docker compose up -d postgres
docker compose run --rm backup restore run <stamp>   # once per database
docker compose up -d
```

The vector index restores with everything else, so nothing is re-embedded.

</details>

---

## Development

```bash
bun install
bun test          # 145 tests
bun run check     # typecheck, lint, test
```

| Package | What it is |
|---|---|
| `packages/core` | Wiki.js client, chunking, search merge, vectors, auth, config |
| `packages/mcp` | MCP server, OAuth authorization server, the tools |
| `packages/indexer` | Sync loop, embeddings, vector writes, internal search API |
| `packages/dashboard` | Metrics interface |
| `docker/backup` | Backup and restore container |
| `website/` | The one-page site |
| `themes/wikijs/` | Optional Wiki.js CSS and JS |

Bun runs TypeScript directly, so there is no build step and the containers run
the source. `bun run --cwd packages/dashboard preview` writes a `preview.html`
with sample data.

How it fits together:

- The indexer is incremental. It fingerprints each page and skips anything
  unchanged, so a pass over an untouched wiki costs nothing.
- Every service with admin credentials prepares the database at boot, under an
  advisory lock, so start order does not matter.
- The dashboard is server-rendered HTML with inline SVG charts. No client
  JavaScript, no chart library, no build step.

**Publishing the website.** `website/index.html` deploys to GitHub Pages on
every push that touches it. Enable Pages once by hand first: **Settings → Pages
→ Build and deployment → Source: GitHub Actions**. This cannot be automated,
because creating a Pages site needs a token with administration rights and
`GITHUB_TOKEN` does not have them.

---

## License

Apache-2.0. See [LICENSE](LICENSE).
