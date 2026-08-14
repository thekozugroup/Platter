# Deploying Platter

This is the document for the person who has decided to run Platter and now needs to not get it
wrong. It assumes you can use a terminal and have a machine with Docker on it. It does not
assume you have run a game panel before.

Read [SECURITY.md](SECURITY.md) before you expose this to anything wider than your own LAN.
The short version: **giving Platter the Docker socket is equivalent to giving it root on the
host.** That is a real decision, and it is the first section of that document.

- [What a Platter install actually is](#what-a-platter-install-actually-is)
- [Install with Docker Compose](#install-with-docker-compose)
- [Install on bare Node](#install-on-bare-node)
- [Environment variables](#environment-variables)
- [What lives in the data directory](#what-lives-in-the-data-directory)
- [SQLite to Postgres](#sqlite-to-postgres)
- [Backing up Platter itself](#backing-up-platter-itself)
- [Upgrades and migrations](#upgrades-and-migrations)
- [Reverse proxy and TLS](#reverse-proxy-and-tls)
- [Ports, forwarding, and the reachability probe](#ports-forwarding-and-the-reachability-probe)
- [mDNS on a network that blocks multicast](#mdns-on-a-network-that-blocks-multicast)
- [Resource planning](#resource-planning)
- [Troubleshooting](#troubleshooting)

---

## What a Platter install actually is

One container, one volume, and however many game containers you create.

```
┌─ host ─────────────────────────────────────────────────────┐
│                                                            │
│  platter  ── /var/run/docker.sock ──▶ dockerd               │
│     :8080 (web UI + REST + WebSocket + MCP)                 │
│     /data (SQLite, metrics, server files, backups)          │
│                                          │                  │
│                                          ▼                  │
│  platter-survival-01J2…   :25000 ─▶ 25565/tcp   (sibling)   │
│  platter-valheim-01J3…    :25003 ─▶ 2456/udp    (sibling)   │
└────────────────────────────────────────────────────────────┘
```

Game servers are **siblings**, not children. Platter asks the host's Docker daemon to create
them, and the daemon publishes their ports on the host directly. Nothing is nested, and
Platter's own network namespace is irrelevant to whether a player can connect.

Every container Platter creates is labelled `platter.managed=true` plus `platter.server.id`,
`platter.server.name`, `platter.blueprint.key` and `platter.node.id`, and is named
`platter-<slug>-<short id>`. That is how you find them by hand:

```bash
docker ps --filter label=platter.managed=true
```

---

## Install with Docker Compose

This is the supported path and the one the [`docker-compose.yml`](../docker-compose.yml) in the
repository describes.

```bash
git clone https://github.com/thekozugroup/Platter.git
cd Platter
cp .env.example .env
```

Now fill in two values in `.env`:

```bash
openssl rand -base64 48              # → JWT_SECRET
stat -c '%g' /var/run/docker.sock    # → DOCKER_GID
```

`DOCKER_GID` matters. The image runs as an unprivileged user (`uid 1001`), so it cannot open
`/var/run/docker.sock` unless it is a member of the group that owns it. Compose adds that group
with `group_add`. On Debian and Ubuntu the answer is usually `999`; on Fedora and on Docker
Desktop for macOS it is often not. Read it, do not guess it.

Set `PUBLIC_HOST` too. It is the address Platter prints as each server's address, and it
defaults to `127.0.0.1`, which is correct only if you are the only player and you are sitting at
this machine. Set it to the LAN address of the host, or to a DNS name that resolves to it.

```bash
docker compose up -d
```

Open <http://localhost:8080> — or `http://<PUBLIC_HOST>:8080` from another machine.

**No account is created for you.** A fresh install reports `needsSetup: true` and serves first-run
setup instead of a login form; the first account you create is always the `owner`, whatever
`REGISTRATION_ENABLED` says. Verified against an empty database with registration closed:

```
$ curl -s localhost:8080/api/v1/system/info
{"version":"0.1.0", … ,"needsSetup":true,"counts":{"users":0,"servers":0,"nodes":1},
 "features":{"ai":false,"metrics":true,"registrationEnabled":false}}

$ curl -s -X POST localhost:8080/api/v1/auth/register -H 'content-type: application/json' \
    -d '{"email":"you@example.com","username":"you","displayName":"You","password":"…"}'
{"user":{ … ,"role":"owner"}, "accessToken":"eyJ…"}

# and the second attempt, once an account exists:
{"error":{"code":"forbidden","message":"Registration is closed. Ask an administrator for an invite."}}
```

Claim the instance as soon as it is up. Between `docker compose up -d` and your first account,
anyone who can reach the port can take the owner account — which is one more reason not to expose
port 8080 to the internet before you have read [SECURITY.md](SECURITY.md).

### Checking it actually came up

```bash
curl -s localhost:8080/api/v1/system/health          # {"status":"ok"}
curl -s localhost:8080/api/v1/system/ready | jq      # database + node checks
curl -s localhost:8080/api/v1/system/info | jq
```

`/health` answers as soon as the process is serving HTTP. `/ready` is the real one: it returns
503 unless the database answers _and_ at least one node's driver answers, with a breakdown of
which failed. It is what the container healthcheck calls, so `docker ps` showing `(healthy)`
means both of those passed within the last 30 seconds.

```json
{
  "ok": true,
  "checks": {
    "database": { "ok": true, "error": null },
    "nodes": { "ok": true, "error": null }
  }
}
```

### Published image or local build

The compose file carries both `image:` and `build:` on purpose. `docker compose up -d` from a
fresh clone builds the image when it is not already present, so the repository is deployable
before anything has been published; once a release exists, `docker compose pull` fetches it
instead of rebuilding.

```bash
docker compose pull && docker compose up -d     # take the published image
docker compose build --no-cache && docker compose up -d   # force your checkout
```

---

## Install on bare Node

You do not need Docker to run _Platter_; you need Docker to run _game servers_. Running the
panel directly is useful for development, for a host where you would rather manage the Node
process with systemd, and for anyone who wants to read what it is doing.

Requirements, from [`package.json`](../package.json): **Node ≥ 22** and **pnpm ≥ 10**
(`packageManager` pins `pnpm@10.33.0`; `corepack enable` will honour it).

```bash
pnpm install
pnpm --filter @platter/shared build           # the API compiles against its dist
pnpm --filter @platter/api exec prisma generate
pnpm build                                    # shared + api + web
```

Then set the environment, migrate, and run:

```bash
cd apps/api

export DATABASE_URL="file:/var/lib/platter/platter.db"
export DATA_DIR=/var/lib/platter
export BACKUP_DIR=/var/lib/platter/backups
export JWT_SECRET="$(openssl rand -base64 48)"
export PUBLIC_HOST=192.168.1.50
export NODE_ENV=production
export PORT=8080

pnpm exec prisma migrate deploy
node dist/main.js
```

Verified output of the migrate step on an empty database:

```
1 migration found in prisma/migrations
Applying migration `00000000000000_init`
All migrations have been successfully applied.
```

Then open the panel and create the first account, exactly as with compose. The default node is
created automatically on first boot.

Notes that will save you an hour:

- **`prisma migrate deploy` must run from `apps/api`.** Prisma resolves a relative SQLite path
  (`file:./data/platter.db`) against the _schema_ directory, not the current directory. Use an
  absolute `file:/…` URL and the ambiguity disappears.
- **There is a seed script, and it is a development convenience.** `pnpm --filter @platter/api db:seed`
  runs `prisma/seed.ts` under `tsx`, creating the default node and — only if no owner exists at
  all — an owner account, printing its generated password exactly once. It is idempotent: it
  never overwrites an existing owner and never resets a password. `tsx` is a devDependency, so
  this is not available in a `--prod` install or in the published image; first-run setup in the
  web client is the real path to the first account.
  ```
  $ SEED_EMAIL=owner@example.com pnpm --filter @platter/api db:seed
  Seeding Platter (development)
    node      created "Local" (docker at /var/run/docker.sock)
    owner     created owner@example.com
  ```
- **The web client is a separate build artefact.** `pnpm --filter @platter/web build` writes
  `apps/web/dist`. See [the web UI 404s](#the-web-ui-404s-but-the-api-answers) for how it is
  served.

### A systemd unit

```ini
[Unit]
Description=Platter
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=platter
SupplementaryGroups=docker
WorkingDirectory=/opt/platter/apps/api
EnvironmentFile=/etc/platter.env
ExecStartPre=/usr/bin/pnpm exec prisma migrate deploy
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
# The process handles SIGTERM itself and drains for up to 20s before forcing an exit.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`SupplementaryGroups=docker` is the bare-metal equivalent of compose's `group_add`, and carries
exactly the same consequence — see [SECURITY.md](SECURITY.md).

The 20 seconds is not arbitrary: `main.ts` gives itself a `SHUTDOWN_TIMEOUT_MS` of 20 000 ms to
stop background loops, drain in-flight requests and close the database, then forces an exit. A
`TimeoutStopSec` below that turns every graceful stop into a SIGKILL.

---

## Environment variables

Everything is configured by environment variable. `apps/api/src/config.ts` parses them through a
zod schema at startup; anything that does not validate **stops the process before it listens**,
with the offending keys named:

```
Platter cannot start: the environment is not valid.
  LOG_LEVEL: Invalid option: expected one of "fatal"|"error"|"warn"|"info"|"debug"|"trace"|"silent"

See .env.example for every supported key.
```

A `.env` file in the process's working directory is loaded first, but **a real environment
variable always wins** — the loader does not override. That is worth remembering when a value in
`.env` appears to be ignored: something in the shell, the unit file or the compose file is
setting it too.

### Core

| Variable       | Default                  | What it does, and what happens when it is wrong                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JWT_SECRET`   | —                        | Signs access tokens. **Required in production**: shorter than 32 characters and the process refuses to start with `JWT_SECRET must be set to at least 32 characters in production`. In development it generates a random one per process and warns — every restart then invalidates every session. Changing it signs everyone out, which is exactly what you want if it leaks. |
| `NODE_ENV`     | `development`            | `production` enables HSTS, marks the refresh cookie `Secure`, and turns the missing-`JWT_SECRET` warning into a fatal error. Anything other than `development`/`test`/`production` fails validation.                                                                                                                                                                           |
| `PORT`         | `8080`                   | Listen port. Non-numeric fails validation (`expected number, received NaN`).                                                                                                                                                                                                                                                                                                   |
| `HOST`         | `0.0.0.0`                | Listen address. Set `127.0.0.1` when a reverse proxy on the same box is the only client.                                                                                                                                                                                                                                                                                       |
| `DATABASE_URL` | `file:./data/platter.db` | Prisma connection string. See [SQLite to Postgres](#sqlite-to-postgres). A path Platter cannot write is a startup failure, not a runtime one — `connectDatabase()` runs before `listen()`.                                                                                                                                                                                     |
| `DATA_DIR`     | `./data`                 | Root of everything on disk. Resolved to an absolute path once, at boot; nothing in the app ever resolves against the current directory afterwards.                                                                                                                                                                                                                             |
| `BACKUP_DIR`   | `./data/backups`         | Where backup archives are written. Can be a different filesystem — that is the point of it being separate.                                                                                                                                                                                                                                                                     |
| `LOG_LEVEL`    | `info`                   | `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`. Anything else fails validation.                                                                                                                                                                                                                                                                                        |

### Networking and addressing

| Variable           | Default     | What it does, and what happens when it is wrong                                                                                                                                                                              |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_HOST`      | `127.0.0.1` | The host part of every address Platter shows a player. Wrong value = every server displays an address nobody can reach; nothing else breaks. **Only read when the first node is created** — see the note below.              |
| `PORT_RANGE_START` | `25000`     | First host port Platter may allocate. Same caveat: first-node only.                                                                                                                                                          |
| `PORT_RANGE_END`   | `25999`     | Last one. `PORT_RANGE_END` below `PORT_RANGE_START` fails validation with `PORT_RANGE_END must be at or above PORT_RANGE_START`. Too small a range and server creation eventually fails with no free port.                   |
| `TRUST_PROXY`      | `false`     | `true`, a hop count (`1`), or a comma-separated subnet list. Controls whether `X-Forwarded-For` is believed. Leave it off unless a proxy you control actually sets it — see [Reverse proxy and TLS](#reverse-proxy-and-tls). |
| `CORS_ORIGINS`     | _(empty)_   | Comma-separated allowlist. Empty means **same-origin only**, which is the normal deployment. There is deliberately no wildcard: reflecting arbitrary origins with credentials enabled would be a session-theft hole.         |
| `RATE_LIMIT_MAX`   | `300`       | Requests per minute per source address, globally. Auth routes have their own much tighter budgets (10/min for login, 5/min for anything minting a credential) and are not affected by this.                                  |

> **`PUBLIC_HOST` and the port range are first-boot only.** `ensureDefaultNode()` creates the
> `Local` node from these three values the first time Platter starts against an empty database,
> and never reconciles them afterwards. Changing them later in `.env` has no effect on an
> existing install. Change the node instead — in the admin area under Nodes, or:
>
> ```bash
> NODE=$(curl -s localhost:8080/api/v1/nodes \
>   -H "authorization: Bearer $ACCESS_TOKEN" | jq -r '.data[0].id')
>
> curl -s -X PATCH "localhost:8080/api/v1/nodes/$NODE" \
>   -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
>   -d '{"publicHost":"play.example.com","portRangeStart":25000,"portRangeEnd":25999}'
> ```
>
> Existing allocations keep the ports they already hold; the range only governs new ones.

### Docker access

| Variable              | Default                | What it does, and what happens when it is wrong                                                                                                                                                                                          |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCKER_SOCKET`       | `/var/run/docker.sock` | Endpoint for the default node. Accepts a bare path, `unix:///path`, or `tcp://host:2375` — the last of which is how you point Platter at a [socket proxy](SECURITY.md#socket-proxy). Also first-boot only, for the same reason as above. |
| `DEFAULT_NODE_DRIVER` | `docker`               | `docker` or `mock`. `mock` is a complete in-memory stand-in used by the entire test suite; it starts nothing real. Do not set it in production — you will get a panel full of servers that do not exist.                                 |
| `DOCKER_GID`          | `999`                  | **Compose only**, not read by the application. Group id added to the container so it can open the socket. Wrong value and every Docker call fails with `EACCES`, which surfaces as an unreachable node in `/ready`.                      |

### Optional integrations

| Variable               | Default                       | Notes                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`    | —                             | Unset is a supported state: `/system/info` reports `features.ai: false` and the client hides the AI surfaces rather than showing broken ones.                                                                                                              |
| `AI_MODEL`             | `claude-opus-5`               | Ignored without a key.                                                                                                                                                                                                                                     |
| `CURSEFORGE_API_KEY`   | —                             | Without it, CurseForge search reports itself as errored in the `sources` array while Modrinth results still return. Modrinth needs no key.                                                                                                                 |
| `MODRINTH_BASE_URL`    | `https://api.modrinth.com/v2` | Point at a mirror or caching proxy. Useful on an install with no egress to `api.modrinth.com`.                                                                                                                                                             |
| `PLATTER_CONTACT`      | —                             | Appended to the Modrinth `User-Agent`. Modrinth asks busy clients for a contact address; setting it gets you a warning instead of a block.                                                                                                                 |
| `METRICS_ENABLED`      | `true`                        | `false` unregisters the HTTP instrumentation hook, so per-request timings and counts stop being collected. The `/system/metrics` endpoint still answers, with the process-level defaults (heap, event-loop lag, file descriptors) and any non-HTTP gauges. |
| `REGISTRATION_ENABLED` | `false`                       | Open registration on a panel that manages root-equivalent infrastructure. Leave it off; invite users from the admin area. The _first_ account can always be created regardless, because an install with no accounts has nobody to invite you.              |

### Behind an egress proxy

| Variable      | Default | Notes                                                            |
| ------------- | ------- | ---------------------------------------------------------------- |
| `HTTPS_PROXY` | —       | Proxy for outbound HTTPS. Lowercase `https_proxy` works too.     |
| `HTTP_PROXY`  | —       | Proxy for outbound HTTP.                                         |
| `NO_PROXY`    | —       | Comma-separated hosts to reach directly. Conventional semantics. |

Set these if your network requires a proxy for outbound traffic, and Platter will route mod
registry and Anthropic requests through it.

This needs saying because it is not the default it looks like: **Node's `fetch` ignores these
variables**, unlike curl, git and npm. An application has to opt in, and Platter does — at
startup in both the API and the `platter mcp` stdio server, which are separate processes. If
you have configured a proxy system-wide and expected it to be picked up automatically, that is
the reason it would not have been.

The symptom when this is wrong is specific and quiet: the panel works perfectly, servers start
and stop, and only mod search fails — with `service_unavailable` and nothing in the log naming
the proxy. Check the startup line `routing outbound HTTP through the configured proxy`; if it
is absent, Platter did not see a proxy variable.

Credentials in a proxy URL are redacted before that line is logged.

### Tokens and sessions

| Variable            | Default | Notes                                                                                                                                         |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCESS_TOKEN_TTL`  | `15m`   | Duration string (`900s`, `15m`, `24h`, `30d`, `2w`) or bare seconds. `15minutes` fails validation with `Use a duration like 15m, 24h or 30d`. |
| `REFRESH_TOKEN_TTL` | `30d`   | Same format. Sets the refresh cookie's `Max-Age` and the session row's expiry.                                                                |

### Startup and seeding

These four are not read by `config.ts`, and none of them is needed for an ordinary deployment.

| Variable        | Default                   | Notes                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SEED_ON_START` | `0`                       | Read by [`docker/entrypoint.sh`](../docker/entrypoint.sh). Off by default because the production image cannot seed — `prisma/seed.ts` is not compiled into `dist` and `tsx` is pruned — so leaving it on would log a "seeding / no runnable seed" pair on every boot that means nothing. Set `1` only on a development image that carries `tsx`. |
| `SEED_EMAIL`    | `owner@platter.local`     | Read by the seed script. Only used when no owner exists at all: re-seeding with a different address does **not** mint a second owner.                                                                                                                                                                                                            |
| `SEED_PASSWORD` | _(generated)_             | Validated against the same rule the API enforces (12 characters minimum), so a seeded account can never be weaker than one created through the UI. An unacceptable value fails the seed loudly rather than silently weakening the account. Unset means a 24-character password is generated and printed once.                                    |
| `WEB_ROOT`      | `/app/web` _(image only)_ | Where the built SPA lives in the image.                                                                                                                                                                                                                                                                                                          |

---

## What lives in the data directory

With the defaults, `/data` inside the container (`platter-data` volume on the host):

```
/data
├── platter.db          SQLite: users, servers, sessions, API keys, audit log, settings,
│                       allocations, schedules, backups, mod proposals
├── metrics.db          A separate SQLite file (node:sqlite) holding the time series.
│                       Deliberately not in platter.db — see below.
├── servers/
│   └── srv_01J2…/      One directory per server. This is the game's data volume: worlds,
│                       saves, server.properties, mods/, plugins/, and .platter/mods.json
└── backups/
    └── srv_01J2…/
        └── bak_01J3….tar.gz
```

**Why metrics are a second database.** CPU, memory, disk, network, player-count and TPS samples
are written continuously and expire on a timer. Mixing rows that are meant to be deleted every
few minutes with rows that must never be lost makes both harder to reason about and puts write
pressure on the file holding your audit log. The retention ladder is fixed in
`services/timeseries.ts`: full-resolution samples for 3 hours, rolled into 1-minute buckets kept
for 48 hours, rolled into 5-minute buckets kept for 14 days, then deleted. Total footprint stays
in the low tens of megabytes even with a few dozen servers.

`metrics.db` is disposable. Losing it costs you charts, not state.

---

## SQLite to Postgres

Most self-hosters running a handful of servers should stay on SQLite. It is one file, it needs
no operating, and an unnecessary database is an unnecessary outage. Move to Postgres when you
have a reason: multiple Platter processes against one database, an existing backup and
replication story you would rather use, or an ops policy that says so.

**What you need to know before you start:**

1. **The committed migration is SQLite DDL.** `prisma/migrations/00000000000000_init/migration.sql`
   contains `DATETIME` columns and SQLite-flavoured table definitions. `prisma migrate deploy`
   against Postgres will not apply it. You generate a fresh migration for the new provider, or
   push the schema directly.
2. **The schema itself is portable, and that is deliberate** — no SQLite-only expressions, no
   native type attributes, closed sets stored as `String` and validated against the shared
   unions. Verified:
   ```
   $ prisma validate --schema ./schema-postgres.prisma
   The schema at ./schema-postgres.prisma is valid 🚀
   ```
3. **Nothing migrates your data.** There is no export/import tool. Treat this as a decision made
   at install time, or accept starting from an empty database.
4. **`metrics.db` stays SQLite regardless.** The time-series store uses `node:sqlite` directly
   and does not read `DATABASE_URL`. Postgres does not change that.

### The procedure

Uncomment the `postgres` service and the `platter-postgres` volume already present in
[`docker-compose.yml`](../docker-compose.yml), then set both variables in `.env`:

```bash
POSTGRES_PASSWORD=$(openssl rand -base64 32)
DATABASE_URL=postgresql://platter:THAT_PASSWORD@postgres:5432/platter
```

Uncomment `DATABASE_URL` on the `platter` service too, and add a dependency so Platter does not
race the database on boot:

```yaml
depends_on:
  postgres:
    condition: service_healthy
```

Change the datasource in [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma):

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Then, from a checkout with dev dependencies, against the empty Postgres database:

```bash
cd apps/api
rm -rf prisma/migrations                    # the SQLite migration cannot apply here
pnpm exec prisma migrate dev --name init    # generates Postgres DDL and applies it
```

Commit the new migration directory. From then on the ordinary
[upgrade path](#upgrades-and-migrations) applies unchanged.

If you would rather not carry migrations at all, `prisma db push` brings an empty database up to
the schema without generating any — the entrypoint script already falls back to `db push` when
`prisma/migrations` is missing or empty.

---

## Backing up Platter itself

Platter backs up **game servers** for you: streamed `tar.gz`, SHA-256 recorded at write time and
verified before any restore, retention rules, and a save-flush/resume pair around the archive so
a world is not captured mid-write. That is the Backups tab, and it is not what this section is
about.

This section is about the panel's own state — accounts, API keys, server definitions, port
allocations, schedules, audit log, mod proposals — which nothing backs up for you.

### What to copy

| Path               | Needed?   | Why                                                                                    |
| ------------------ | --------- | -------------------------------------------------------------------------------------- |
| `/data/platter.db` | **Yes**   | Everything Platter knows. Losing it means every server becomes an unmanaged container. |
| `/data/servers/`   | **Yes**   | The worlds. Usually the largest thing by far.                                          |
| `/data/backups/`   | Your call | Archives of the above. Skip if you have a separate retention story.                    |
| `/data/metrics.db` | No        | Charts only. Regenerates itself.                                                       |
| `.env`             | **Yes**   | Specifically `JWT_SECRET`. Restoring the database without it signs everyone out.       |

### A backup that is actually consistent

SQLite is a live file; `cp` while a write is in flight can capture a torn page. Use SQLite's own
online backup, which is safe against a running process. There is no need to install `sqlite3`
into the container — the image has Node 22, whose built-in `node:sqlite` can do it:

```bash
docker compose exec platter node -e \
  "const{DatabaseSync}=require('node:sqlite');
   const db=new DatabaseSync('/data/platter.db');
   db.exec(\"VACUUM INTO '/data/platter-backup.db'\");
   db.close();"

docker compose cp platter:/data/platter-backup.db ./platter-$(date +%F).db
docker compose exec platter rm /data/platter-backup.db
```

Verified against a running instance: the copy opened cleanly and carried the same row counts as
the live database. `VACUUM INTO` also compacts, so the copy is usually smaller than the original.

If you would rather not touch the running container at all, stop it first — a stopped Platter is
a consistent one, and the game containers keep running because they are siblings, not children:

```bash
VOL=$(docker volume ls -q | grep platter-data)     # compose prefixes it with the project name

docker compose stop platter
docker run --rm -v "$VOL":/data -v "$PWD":/out alpine \
  tar czf /out/platter-data-$(date +%F).tar.gz -C /data platter.db servers
docker compose start platter
```

The volume lookup is not paranoia: compose names volumes `<project>_<volume>`, so a clone in a
directory called `Platter` gives you `platter_platter-data`, not `platter-data`.

Note the deliberate omission of `metrics.db` from that archive: it is large, it is worthless to
a restore, and excluding it makes the backup meaningfully smaller.

### Restoring

```bash
VOL=$(docker volume ls -q | grep platter-data)

docker compose down
docker run --rm -v "$VOL":/data -v "$PWD":/in alpine \
  sh -c 'rm -rf /data/platter.db /data/servers && tar xzf /in/platter-data-2026-08-01.tar.gz -C /data'
docker compose up -d
```

On the next boot, `reconcile()` runs **before the port is bound** and compares every stored
server status against what the runtime actually reports. A server the database thinks is running
but whose container is gone is corrected to `offline` rather than being reported as healthy, and
containers with Platter's labels that no database row claims are surfaced as orphans in the boot
log:

```
reconciled servers against the runtime  checked=3 corrected=1 started=0 resumed=0 orphans=0
```

---

## Upgrades and migrations

```bash
cd Platter
git pull                       # if you build locally
docker compose pull            # if you use the published image
docker compose up -d
```

Migrations run in [`docker/entrypoint.sh`](../docker/entrypoint.sh) before the API process
starts, not from inside the app. That is deliberate: a container that cannot migrate fails
immediately and visibly instead of starting up and throwing query errors on the first request.

```
platter: applying database migrations
1 migration found in prisma/migrations
No pending migrations to apply.
platter: starting
```

`prisma migrate deploy` only ever applies committed migrations. It never generates one, never
resets, and never drops anything.

**There is no down migration.** Prisma does not generate them and Platter does not hand-write
them. Rolling back to an older image after a migration has applied means restoring the database
from before the upgrade. So:

1. Back up `platter.db` (above) **before** `docker compose up -d`.
2. Watch the boot log once. If the entrypoint fails, the container exits before listening and
   `docker compose logs platter` has the reason on the last line.
3. Confirm `/api/v1/system/ready` returns 200 before you walk away.

Game containers are untouched by a Platter upgrade. They keep running through it — the panel
goes away for a few seconds and comes back, and `reconcile()` re-establishes the truth.

---

## Reverse proxy and TLS

Platter serves everything from one origin and one port: the API under `/api/v1`, the OpenAPI
browser at `/docs`, the console WebSocket at `/ws/servers/:serverId/console`, and MCP at
`/api/v1/mcp`. There is no second service to route.

Three things people get wrong, in order of how often:

1. **The WebSocket upgrade.** The live console is a WebSocket on the same origin. A proxy that
   does not forward `Upgrade` and `Connection` turns it into a plain HTTP request, which fails
   with no useful message. The console shows as permanently connecting.
2. **Response buffering.** MCP over streamable HTTP answers with Server-Sent Events. A proxy that
   buffers responses holds the entire stream until it ends, so an MCP client sits there receiving
   nothing.
3. **Upload size.** File uploads stream through the API with a 2 GiB per-file ceiling
   (`LIMITS.maxUploadBytes`). A proxy with a 1 MB default body limit rejects a world upload before
   Platter ever sees it.

### nginx

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl http2;
  server_name platter.example.com;

  ssl_certificate     /etc/letsencrypt/live/platter.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/platter.example.com/privkey.pem;

  # World uploads stream through the API. Platter's own ceiling is 2 GiB per file.
  client_max_body_size 2g;
  # Do not buffer a 2 GiB upload to disk before forwarding it.
  proxy_request_buffering off;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;

    # This pair is the WebSocket upgrade. Without it the console never connects.
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # A console that is quiet for a minute must not be torn down. The default is 60s.
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
  }

  # MCP answers with Server-Sent Events. Buffering here means the client receives nothing
  # until the stream ends, which for a long-lived session is never.
  location /api/v1/mcp {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    chunked_transfer_encoding off;
  }
}
```

### Caddy

Caddy handles the WebSocket upgrade and streaming without being told, which is most of why it is
worth recommending. The whole file:

```caddyfile
platter.example.com {
  encode zstd gzip

  # SSE must not be buffered or compressed on the way through.
  @mcp path /api/v1/mcp*
  handle @mcp {
    reverse_proxy 127.0.0.1:8080 {
      flush_interval -1
    }
  }

  handle {
    reverse_proxy 127.0.0.1:8080
  }

  request_body {
    max_size 2GB
  }
}
```

`flush_interval -1` disables response buffering for that route. Everything else — TLS
certificates, HTTP/2, the `Upgrade` header — Caddy does correctly by default.

### After you put a proxy in front

Two settings on Platter's side:

- **`NODE_ENV=production`.** The refresh cookie is only marked `Secure` in production. Behind
  TLS with `NODE_ENV=development` you are sending a 30-day credential over a cookie that would
  also travel over plain HTTP. This is already the default in the container image.
- **`TRUST_PROXY`.** Off by default, and that is correct for a directly exposed instance:
  without it, `X-Forwarded-For` is ignored and cannot be spoofed. Behind a proxy you control,
  set it — otherwise every rate-limit bucket and every audit-log `ip` records the proxy's
  address, so one brute-forcer exhausts the login budget for everybody. Values: `true` (trust
  the immediate peer), `1` (trust one hop), or a subnet list like `10.0.0.0/8,172.16.0.0/12`.

You do **not** need `CORS_ORIGINS`. The SPA is served from the same origin as the API; leaving
the allowlist empty means same-origin only, which is what you want.

### What the proxy does not cover

Game traffic does not go through it. A Minecraft client speaks the Minecraft protocol to
`25000/tcp` on the host, not HTTPS to nginx. TLS in front of Platter protects the panel, the
console and the API — not the game ports.

---

## Ports, forwarding, and the reachability probe

Platter allocates a host port per blueprint port, from the node's range, on creation. A
Minecraft: Java server takes three:

```
game   0.0.0.0     25000  tcp    ← players connect here
query  0.0.0.0     25001  udp    ← server-list pings
rcon   127.0.0.1   25002  tcp    ← admin channel, loopback only
```

That `127.0.0.1` on RCON is not a typo and is not configurable per install: RCON is a plaintext
protocol where a successful auth is arbitrary console execution, so blueprints that expose it
mark the port `bindLocal`, and on a node that shares this machine's network stack Platter binds
it to loopback. Platter reaches it from inside the same host; nothing else on your network can.
(On a _remote_ node the port has to be bound normally, because otherwise Platter itself could not
reach it — a reason to think carefully before adding remote nodes.)

### Forwarding

For friends outside your network, forward the **game** port — and the query port if you want the
server visible to server-list sites — from your router to `PUBLIC_HOST:same port`. Do not forward
RCON. Do not forward Platter's own `8080` without TLS and a considered read of
[SECURITY.md](SECURITY.md).

Keeping the host port equal to the external port matters for Minecraft: the SRV record Platter
publishes names the port it knows about.

### What the reachability probe is telling you

`GET /api/v1/servers/:serverId/network/reachability`, and the **Check** button next to the
address in the UI:

```json
{
  "host": "127.0.0.1",
  "port": 25000,
  "protocol": "tcp",
  "listening": false,
  "connected": false,
  "reachability": "unreachable",
  "detail": "Nothing is listening on this port yet — the server may still be starting.",
  "latencyMs": 3,
  "checkedAt": "2026-08-08T20:26:46.450Z"
}
```

Read it honestly, because it is written honestly:

| Field          | Meaning                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listening`    | Result of a _local bind test_: Platter tried to bind the port itself. `false` means the port was free — nothing is listening. `true` means something holds it. `null` means the node is not local to this process, so the test was skipped. |
| `connected`    | A TCP connect succeeded, or a UDP datagram drew a real reply.                                                                                                                                                                               |
| `reachability` | `unreachable`, `lan`, or `unknown`.                                                                                                                                                                                                         |

**`lan` is the strongest answer this probe can ever give, and that is a deliberate limit.**
Proving the _internet_ can reach a port requires a vantage point outside your network, which
Platter does not have and will not pretend to. If you need that answer, ask a friend to connect,
or use an external port checker.

`unknown` is almost always UDP. UDP has no handshake: a healthy Valheim server that only replies
to its own protocol looks exactly like one that is not running. Only two UDP outcomes are
conclusive — an actual reply, or the OS returning "port unreachable" — and silence is neither.
`unknown` means _not testable_, never _down_.

The same logic is available to an agent through the `check_reachability` MCP tool, which probes
every allocated port at once and appends the same caveat to its summary.

---

## mDNS on a network that blocks multicast

Platter advertises every running server as `<slug>.platter.local` over mDNS, plus a
`_minecraft._tcp` SRV record so a Java player can type a bare hostname with no port. This works
with zero configuration on macOS and iOS, and on Linux and Windows where mDNS is available.

It also fails silently on a great many networks, because plenty of them block multicast:
enterprise and university wireless with client isolation, most guest networks, many mesh systems
across bands, VLAN-segmented setups, and Docker's default bridge for a container that is not on
the host network.

**Nothing breaks when it fails.** The failure is contained by design:

- `registerServer()` never throws. A server starts whether or not it can be advertised.
- The responder's `error` event is caught and latched. Without that catch, an unhandled `error`
  event from a failed multicast join would be fatal to the Node process — a LAN convenience
  feature is not allowed to take the panel down.
- Once it fails, it is marked unavailable for the life of the process and not retried, with one
  warning in the log:
  ```
  WARN mDNS is unavailable on this host; servers fall back to host:port addresses
  ```
- The address a player is shown falls back automatically. `connectString` returns the bare
  hostname only when the hostname actually resolves _and_ an SRV record covers the port;
  otherwise `hostname:port`; otherwise the raw `ip:port`. The API reports `mdnsAvailable: false`
  and the UI stops promising a name it cannot deliver.

### If you want names anyway

Use a real domain. Platter renders the exact zone-file lines for you at
`GET /api/v1/network/zone` (Network → DNS in the UI): a wildcard A record pointing at your public
IP, plus one SRV record per Minecraft server. Paste them into your DNS provider.

```bash
curl -s -X PUT http://localhost:8080/api/v1/network/zone \
  -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"zone":"games.example.com","publicIp":"203.0.113.7"}' | jq -r .zoneFileText
```

```
; Platter DNS zone for games.example.com
; Generated 2026-08-08T20:49:07.690Z — add these records at your DNS provider.

*.games.example.com.	300	IN	A	203.0.113.7
_minecraft._tcp.survival.games.example.com.	120	IN	SRV	0 5 25000 survival.games.example.com.
```

`GET` on the same path reads it back without changing anything; with the default `platter.local`
zone the A record's target renders as `<YOUR-PUBLIC-IP>` until you set one. This is
infrastructure, not a per-server setting, so it is admin-only and lives outside any one server.

If you want `.local` names on a network that blocks multicast, the only real fix is at the
network: enable mDNS reflection/repeater on the router or controller. That is outside what
Platter can do from inside a container.

---

## Resource planning

### Platter itself

The panel is not the expensive part, and it is not the bottleneck for any game. Budget roughly:

- **Memory:** low hundreds of MB for the Node process. It holds a bounded ring buffer of 500
  console lines per server with an open console, one log stream per server regardless of how
  many people are watching, and a metrics sample buffer flushed on a timer.
- **CPU:** near-idle. The regular work is a stats poll per server, the scheduler tick, and the
  metrics rollup.
- **Disk:** `platter.db` in the low tens of MB for a normal install; `metrics.db` similar, and
  bounded by its retention ladder rather than by time.
- **Sockets:** one Docker log stream per running server; a pooled RCON connection per server that
  speaks it, capped at 64 and closed after 5 minutes idle; at most 8 console WebSockets per user;
  and at most 32 concurrent MCP sessions per process.

### Games

From the shipped blueprints (`apps/api/src/blueprints/`) — minimum, recommended, minimum disk,
and how many host ports each one consumes:

| Blueprint              | Min RAM | Recommended | Min disk | Ports |
| ---------------------- | ------- | ----------- | -------- | ----- |
| `terraria`             | 512 MB  | 1.5 GB      | 2 GB     | 1     |
| `minecraft-bedrock`    | 512 MB  | 1.5 GB      | 2 GB     | 1     |
| `minecraft-java`       | 1 GB    | 4 GB        | 8 GB     | 3     |
| `factorio`             | 1 GB    | 4 GB        | 4 GB     | 2     |
| `dont-starve-together` | 1 GB    | 2 GB        | 4 GB     | 4     |
| `valheim`              | 2 GB    | 4 GB        | 4 GB     | 3     |
| `counter-strike-2`     | 2 GB    | 4 GB        | 60 GB    | 3     |
| `project-zomboid`      | 2 GB    | 6 GB        | 8 GB     | 4     |
| `rust`                 | 8 GB    | 16 GB       | 30 GB    | 3     |
| `satisfactory`         | 8 GB    | 12 GB       | 25 GB    | 3     |
| `palworld`             | 8 GB    | 16 GB       | 16 GB    | 4     |
| `enshrouded`           | 12 GB   | 16 GB       | 30 GB    | 1     |

Read the disk column before you plan: Counter-Strike 2 wants 60 GB for the game files alone,
before a single backup exists.

**Sizing rules that hold up:**

- Add the _recommended_ figures, not the minimums, then add ~1 GB for Platter and whatever the
  host OS needs. The minimum column is what will boot; the recommended column is what will not
  stutter.
- Memory is not overcommitted by default. The node carries an `overcommitRatio` of 1, so
  allocations are checked against real capacity and creation is refused when a node is full.
- Backups double your disk requirement, roughly. A world compresses, but retention keeps several
  copies. Point `BACKUP_DIR` at a different filesystem if you can.
- Default port range (`25000`–`25999`) is 1000 ports, so it is not the constraint — but a
  four-port game means 250 servers, not 1000, and every one of those ports has to be forwarded
  if players are outside your network.
- CPU: game servers are largely single-threaded on their main tick. Four cores comfortably runs
  several small servers; one core and three Minecraft servers will produce TPS complaints that
  are not Platter's fault and that no amount of tuning in the panel will fix.

---

## Troubleshooting

Every failure here is one the code actually produces. Where a message is quoted, that is the
exact string.

### The container exits immediately after `docker compose up -d`

```bash
docker compose logs platter | tail -20
```

Three common endings:

**`Platter cannot start: the environment is not valid.`** followed by a list of keys. Fix the
named keys in `.env`. This is a startup abort, not a crash — the process never listened.

**`Platter cannot start: JWT_SECRET must be set to at least 32 characters in production.`**
`JWT_SECRET` is empty or too short. `openssl rand -base64 48`.

**`platter: cannot find the prisma CLI; it must be a production dependency of @platter/api`**
The image is broken, not your configuration. Report it with the image tag.

### `/ready` returns 503 with `"No configured node is reachable."`

Platter cannot talk to the Docker daemon. In order of likelihood:

```bash
# 1. Is the socket mounted?
docker compose exec platter ls -l /var/run/docker.sock

# 2. Does the group match the host's?
stat -c '%g' /var/run/docker.sock          # host
docker compose exec platter id             # container — DOCKER_GID must appear in groups
```

A mismatch produces `EACCES` on every Docker call. Fix `DOCKER_GID` in `.env` and
`docker compose up -d` to recreate the container — `group_add` is applied at creation, so
restarting is not enough.

If you changed `DOCKER_SOCKET` after first boot, note that it is only read when the default node
is created. Update the node's endpoint through the API or admin UI instead.

### `/ready` returns 503 with `"The database is not reachable."`

The volume is not writable, or `DATABASE_URL` points somewhere that does not exist. `db.ts`
creates `DATA_DIR`, `DATA_DIR/servers`, `BACKUP_DIR` and the SQLite file's parent directory on
connect, so this usually means permissions rather than a missing directory. The image runs as
uid 1001; a host bind-mount owned by root will fail.

### The web UI 404s but the API answers

```
$ curl -s localhost:8080/
{"error":{"code":"not_found","message":"No route for GET /."}}
```

The API process is not serving the built SPA. `WEB_ROOT` must point at a directory containing
`index.html` — in the published image that is `/app/web`, populated from `apps/web/dist` at build
time. On a bare-Node install, build the client (`pnpm --filter @platter/web build`) and point
`WEB_ROOT` at `apps/web/dist`, or serve that directory from your reverse proxy and route only
`/api`, `/ws` and `/docs` to Platter.

The API itself is unaffected either way: `/api/v1/system/health` and `/docs` answering means the
process is fine.

### A server sits in `provisioning` forever

The first start pulls a multi-gigabyte image. Watch it happen:

```bash
docker compose logs -f platter | grep -i pull
docker images | grep itzg
```

If the pull is failing, the server ends in `install_failed`, not `provisioning`. Check the
server's console — the pull error is in it — and confirm the host has egress to the registry.

### A Minecraft server starts and immediately stops

Almost always the EULA. The `diagnose_crash` MCP tool names it exactly, and the same
signature drives what the panel shows:

```
eula_not_accepted — The Minecraft EULA has not been accepted.
                    Set the EULA variable to true and reinstall.
```

The other signatures Platter recognises from log output, each with the evidence line attached:
`port_in_use`, `jvm_out_of_memory`, `unsupported_java_version`, `corrupt_world`,
`exception_thrown`. These are _readings_, not diagnoses — each one carries the log line it came
from so you can disagree with it.

### `Address already in use` in a game server's log

The allocation is stale, or something outside Platter holds the port. Platter checks the host
before handing out a port when the node is local, but a process that grabbed it since is
invisible until the container tries to bind.

```bash
ss -ltnp | grep 25000
```

Change the port from the server's Network tab, or with
`PATCH /api/v1/servers/:id/network/allocations/game`
with a new `hostPort`. The change takes effect on the server's **next start** — a running
container keeps its current mapping until then, which the response tells you via
`requiresRestart`.

### The console never connects

If the API is reachable but the console spins, the WebSocket upgrade is being dropped. Test the
upgrade directly — a correctly proxied Platter answers `101`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://localhost:8080/ws/servers/srv_01J2…/console
```

`101` direct but not through the proxy means the proxy config is the problem — see
[Reverse proxy and TLS](#reverse-proxy-and-tls). Note that the socket authenticates in its first
frame, not in the URL, so a 101 here is expected without credentials; a token in a query string
would end up in every proxy access log, which is why it is not done that way.

### Everything returns 429

```json
{ "error": { "code": "rate_limited", "message": "Too many requests. Try again in 1 minute." } }
```

Buckets are keyed by source address and by nothing the client can choose. Behind a proxy without
`TRUST_PROXY` set, _every_ request appears to come from the proxy, so all your users share one
bucket. Set `TRUST_PROXY`. If you genuinely need a higher ceiling, raise `RATE_LIMIT_MAX` — but
note the auth routes have their own fixed budgets (10/min for login, 5/min for the endpoints that
mint credentials) which `RATE_LIMIT_MAX` does not affect, and which exist to make password
spraying useless.

### `Blocked for repeatedly exceeding the rate limit.`

A 403, not a 429: the limiter has stopped counting and started refusing. Wait out the window.

### I lost the owner password

Passwords are stored only as argon2id hashes and there is no reset-by-email flow. If another
owner or admin account still works, change the password from the Users area. If nothing works,
create a rescue owner directly against the database:

```bash
docker compose exec platter node -e "
const { PrismaClient } = require('@prisma/client');
const { hash } = require('@node-rs/argon2');
const p = new PrismaClient();
hash(process.argv[1], { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 })
  .then(h => p.user.create({ data: {
    id: 'usr_' + Date.now(), email: 'rescue@example.com', username: 'rescue',
    displayName: 'Rescue', passwordHash: h, role: 'owner', avatarColor: '#5b8def' } }))
  .then(u => console.log('created', u.email))
  .finally(() => p.\$disconnect());
" 'a-password-of-at-least-12-characters'
```

Then sign in, promote or delete accounts as needed, and delete the rescue account. Those argon2
parameters are not decorative — they must match `lib/password.ts` or the hash will not verify.

### A user is locked out by TOTP

Recovery codes are the intended route. Failing that, an owner or admin can clear the second
factor from the Users area. Directly in the database:

```bash
docker compose exec platter node -e "
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
p.user.update({ where: { email: 'them@example.com' },
                data: { totpEnabled: false, totpSecret: null, lastTotpStep: null } })
 .then(() => console.log('cleared')).finally(() => p.\$disconnect());
"
```

### `That backup archive failed its checksum check and will not be restored.`

The archive on disk does not match the SHA-256 recorded when it was written. Platter refuses
rather than extracting a corrupt world over a working one. The archive is damaged — bad disk,
interrupted copy, edited file. Use an older backup.

You will also see `That backup has no recorded checksum and cannot be safely restored.` for a row
whose backup never completed.

### Mod install fails with `did not publish a checksum`

```
modrinth did not publish a checksum for some-mod-1.0.jar, so Platter cannot verify it.
```

Working as intended. Platter will not place an unverifiable jar into a directory the game
executes from. Nothing was downloaded. Report it to the mod's provider, or install it by hand
through the file manager and accept that you are the one verifying it.

### An MCP client can connect but every tool is refused

```
forbidden: This API key is not scoped for server.create.
```

The key was minted with a scope list that does not include what the tool needs. Scopes are fixed
at creation — mint a new key with the right ones. See [MCP.md](MCP.md#minting-a-key) for the
scope each tool requires.

`This API key is not allowed to act on the account itself.` means something asked for an
admin-level or account-level route with a _restricted_ key. Those routes accept unrestricted keys
only, by design; a scope vocabulary that cannot name the grant must not be assumed to hold it.

### Prometheus scrape returns 403

```
$ curl -s localhost:8080/api/v1/system/metrics -H "X-API-Key: plt_… (scoped key)"
{"error":{"code":"forbidden","message":"This API key is not allowed to act on the account itself."}}
```

`/system/metrics` requires the `admin` role, and role-gated routes refuse _any_ scoped key. Scrape
with an **unrestricted** key (created with an empty `scopes` array) belonging to an admin or
owner account. Verified: the same request with a scoped key returns 403, with an unrestricted one
returns 200 and the exposition text.

Note the header. The REST API accepts an API key **only** in `X-API-Key` — `Authorization: Bearer`
is parsed as an access token, so a key sent that way comes back `401 That token is not valid`.
(MCP is the exception and accepts both; see [MCP.md](MCP.md).)

```yaml
scrape_configs:
  - job_name: platter
    metrics_path: /api/v1/system/metrics
    scheme: https
    static_configs: [{ targets: ['platter.example.com'] }]
    http_headers:
      X-API-Key:
        values: ['plt_xxxxxxxx.your-unrestricted-key']
```

`http_headers` needs Prometheus 2.51 or newer. On an older one, put a tiny proxy in front that
adds the header, or scrape through a sidecar.

`METRICS_ENABLED=false` stops the per-request HTTP instrumentation; the endpoint itself remains
and serves the process-level defaults. Put it behind your proxy if you would rather it were not
reachable at all.

### Nothing here matches

Turn up the log level and read what it actually says:

```bash
docker compose down
LOG_LEVEL=debug docker compose up          # foreground, so you see everything
```

Every error the API returns carries a `requestId`, and that same id is in the log line for the
request that produced it. Quote both when reporting a bug.
