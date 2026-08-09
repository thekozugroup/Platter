# Security

This document is written to be useful rather than reassuring. Where a control is strong it says
so and says why; where the boundary is soft it says that too. If you are deciding whether to
expose a Platter instance to the internet, the honest answer lives in the first two sections.

- [Threat model](#threat-model)
- [The Docker socket is root](#the-docker-socket-is-root)
- [Authentication](#authentication)
- [Authorisation](#authorisation)
- [What an AI agent can and cannot do](#what-an-ai-agent-can-and-cannot-do)
- [The mod supply chain](#the-mod-supply-chain)
- [Input handling](#input-handling)
- [Logging and redaction](#logging-and-redaction)
- [Hardening checklist](#hardening-checklist)
- [What Platter does not protect you from](#what-platter-does-not-protect-you-from)
- [Reporting a vulnerability](#reporting-a-vulnerability)

---

## Threat model

**What Platter is.** A control plane with root-equivalent authority over one host, exposing a web
UI, a REST API, a WebSocket console and an MCP endpoint, operated by a small number of people who
mostly trust each other, on a machine that also runs game servers reachable from the internet.

### Adversaries this design takes seriously

| Adversary                                                    | What they get to do                                                                                          | What stops them                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Someone on the internet with the URL**                     | Reach the login page, the unauthenticated `/health`, `/ready` and `/info`, and every game port you forwarded | argon2id password hashing, a 10/minute login budget, no account enumeration, closed registration by default, no default credentials                                                                                    |
| **A player on your Minecraft server**                        | Send arbitrary game input; possibly place blocks, run commands you granted them                              | Nothing in Platter is exposed to them. RCON binds to loopback on a local node. Game exploits are the game's problem                                                                                                    |
| **An invited collaborator**                                  | Whatever their per-server permissions say                                                                    | 20 per-server permissions checked on every route and every MCP tool; a server they hold no grant on returns 404, not 403                                                                                               |
| **A leaked API key**                                         | Whatever that key's scopes allow, on whatever servers its owner can see                                      | Scopes fixed at mint time; keys can be given an expiry; keys cannot mint keys, cannot change account security settings, and cannot approve a mod                                                                       |
| **A confused or hostile AI agent**                           | Every MCP tool its key is scoped for                                                                         | No tool installs a file. Destructive tools require an explicit confirmation argument. Every write is audited with the agent's identity                                                                                 |
| **A compromised mod registry, or someone on the path to it** | Serve a different jar than the one a human reviewed                                                          | HTTPS-only downloads from a per-source host allowlist, published checksum verified before the file is moved into place, and a drift gate that re-reads upstream at approval and refuses to install anything that moved |
| **A stolen refresh cookie**                                  | Impersonate a session until it is used once                                                                  | Refresh tokens rotate on every use; replaying a rotated token revokes the entire token family                                                                                                                          |

### Adversaries this design does not stop

Stated plainly, because a security document that only lists wins is marketing.

- **Anyone who can reach the Docker socket.** That is root on the host. See the next section.
- **A malicious mod that a human approved.** Approval is the trust boundary. A jar runs inside the
  game container with that container's privileges; Platter verifies _which_ jar you got, not what
  it does.
- **An admin or owner.** They can read every file on every server, run arbitrary console commands
  and delete anything. There is no Platter-level control above them; the audit log records what
  they did, it does not prevent it.
- **A host-level attacker.** Anyone with a shell on the host reads `platter.db` and the JWT
  secret. Platter's controls stop at that boundary.
- **The game protocols.** RCON is plaintext with no transport security; the Minecraft query
  protocol is unauthenticated. Platter uses them because they are what the servers speak.
- **Denial of service.** Rate limits exist to make credential guessing useless and to bound
  obvious floods. They are not a DDoS defence.

---

## The Docker socket is root

Platter manages game servers by asking the host's Docker daemon to create them, which means it
needs `/var/run/docker.sock`.

**Access to the Docker socket is equivalent to root on the host.** Not "close to root", not
"root within a container". Anyone who can talk to the daemon can run:

```bash
docker run -v /:/host -it alpine chroot /host sh
```

and they are root on your machine, with your filesystem, your SSH keys, your other containers'
data and your `/etc/shadow`. The container's own `USER platter` and `no-new-privileges:true` do
not change this, because the privilege is not exercised inside the container — it is exercised by
asking a root daemon to do something on your behalf.

So the security of a Platter instance is, in practice, the security of its login page. Anything
that gets code execution inside the Platter container gets root on the host.

### When the default is acceptable

Running Platter with the socket mounted is a reasonable choice when:

- The host exists to run game servers, and Platter is its most privileged workload anyway.
- The people with accounts are people you would give an SSH login.
- The panel is not exposed to the internet, or is exposed behind TLS with a strong owner
  password, TOTP enabled, and registration closed.

That describes most self-hosting, and it is why the default `docker-compose.yml` does it.

### When it is not

- **Multi-tenant.** If you sell or lend server slots, an admin account is a root account. Do not
  do this with the default configuration.
- **A shared host.** If the machine does anything else that matters — your mail, your backups,
  another project's data — a Platter compromise takes those too.
- **Compliance.** If you have to answer for what a service can reach, "everything" is a bad
  answer.

### Rootless Docker

The strongest available mitigation, and it is not exotic. In [rootless
mode](https://docs.docker.com/engine/security/rootless/) the daemon runs as an unprivileged user
in a user namespace; its "root" maps to a normal uid on the host. A compromise gets root inside
the namespace, which is your unprivileged user outside it.

```bash
dockerd-rootless-setuptool.sh install
export DOCKER_HOST=unix:///run/user/$UID/docker.sock
```

Then point Platter at that socket instead:

```yaml
volumes:
  - platter-data:/data
  - /run/user/1000/docker.sock:/var/run/docker.sock
group_add:
  - '1000' # stat -c '%g' /run/user/1000/docker.sock
```

Trade-offs, so you are not surprised: binding ports below 1024 needs extra configuration
(irrelevant here — the default range is 25000–25999), some storage drivers behave differently,
and overall performance is slightly lower. For a game panel none of that is likely to matter.

### Socket proxy

The other mitigation: put a filtering proxy between Platter and the daemon so it can only call the
endpoints it actually uses. `DOCKER_SOCKET` accepts a `tcp://` endpoint precisely so this works.

These are the Docker API surfaces the driver calls, read off
[`apps/api/src/orchestration/docker.ts`](../apps/api/src/orchestration/docker.ts):

| Call                                                   | Used for                           |
| ------------------------------------------------------ | ---------------------------------- |
| `version`, `info`                                      | Node health, CPU/memory capacity   |
| `images/create` (pull)                                 | Installing a server                |
| `containers/create`, `start`, `stop`, `kill`, `remove` | Lifecycle                          |
| `containers/json` (list, filtered by label)            | Reconciliation, orphan detection   |
| `containers/{id}/json` (inspect)                       | Status, exit code, OOM flag        |
| `containers/{id}/stats`                                | The monitoring graphs              |
| `containers/{id}/logs`                                 | Console history and streaming      |
| `containers/{id}/attach`                               | Writing a console command to stdin |
| `containers/{id}/exec`                                 | Disk usage inside the volume       |

With [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) that is
roughly:

```yaml
docker-proxy:
  image: tecnativa/docker-socket-proxy:latest
  environment:
    POST: 1 # required: creating and starting containers
    CONTAINERS: 1
    IMAGES: 1 # required: pulling game images
    EXEC: 1 # required: disk usage
    INFO: 1
    VERSION: 1
    # Everything else stays 0 — notably:
    VOLUMES: 0
    NETWORKS: 0
    SERVICES: 0
    SWARM: 0
    SYSTEM: 0
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
  restart: unless-stopped

platter:
  environment:
    DOCKER_SOCKET: tcp://docker-proxy:2375
  # and drop the socket bind mount from `volumes`
```

Be clear-eyed about what this buys. `POST: 1` plus `CONTAINERS: 1` is enough to create a
container with a host bind mount, which is enough to become root on the host. A socket proxy
narrows the blast radius of a _bug_ — a path traversal, an SSRF — considerably. It does not
contain an attacker who has full control of the Platter process. **Rootless Docker is the control
that actually changes the outcome; the proxy is defence in depth.**

`DOCKER_SOCKET` is read only when the default node is first created. On an existing install,
change the node's endpoint through the admin UI or `PATCH /api/v1/nodes/:id`.

---

## Authentication

### Passwords

argon2id via `@node-rs/argon2`, at OWASP's 2024 baseline: **19 MiB memory, 2 passes, 1 lane**
([`lib/password.ts`](../apps/api/src/lib/password.ts)). Memory is where the cost falls, because
memory is what an attacker with GPUs cannot cheaply buy. A verify lands near 50 ms — slow enough
to matter offline, fast enough that a login does not feel broken.

Minimum length is 12 characters (`LIMITS.passwordMin`), enforced by the same schema for the API,
the UI and the seed script, so no path can create a weaker account than any other.

**No account enumeration.** A login for an address that does not exist still burns one argon2
verify against a dummy hash, so "unknown email" and "wrong password" take the same time and
return the same `invalid_credentials`. Both are written to the audit log with a `reason` — the
operator can tell them apart; the attacker cannot.

**Rate limits** ([`plugins/security.ts`](../apps/api/src/plugins/security.ts)): 10 requests per
minute per source address on the auth routes, 5 per minute on anything that mints a long-lived
credential, 300 per minute globally by default. Buckets are keyed on `request.ip` and on nothing
a caller can choose — keying on an unverified API key prefix would let an attacker mint a fresh
empty bucket per request by sending junk.

### Sessions

Two tokens, deliberately split:

- **Access token** — a JWT, 15 minutes by default, held in memory by the SPA and sent as
  `Authorization: Bearer`. It carries `typ: 'access'`, checked on verify so nothing else signed
  with the same key can be presented as one.
- **Refresh token** — 256 bits of CSPRNG output, stored as a SHA-256 digest, delivered in an
  `httpOnly`, `SameSite=Lax` cookie scoped to `/api/v1/auth` and marked `Secure` in production.

XSS cannot read the refresh cookie; CSRF can only reach the short-lived token, which it cannot
read either. `SameSite=Lax` rather than `Strict` so a top-level navigation from an external link
back into Platter does not drop the session.

**Rotation with replay detection.** Every refresh revokes the presented token and issues a new one
in the same _family_. If a revoked token is ever presented again, Platter cannot tell a replay
from a legitimate client that raced its own refresh — so it burns the whole family, logs
`refresh token reuse detected; family revoked`, and makes the user sign in again. A fresh login
starts a new family, so revoking one compromised chain does not sign you out on your other
devices.

Deleting an account, suspending it, or changing `JWT_SECRET` invalidates access immediately.
Access tokens are not individually revocable within their 15-minute window; suspension is checked
against the database on every request, so a suspended account is refused even with a valid token.

### Two-factor

TOTP, SHA-1 / 6 digits / 30 seconds — not configurable, because every authenticator app assumes
those and being interesting here only breaks people's phones. Verification accepts one step either
side of now for clock skew.

**Codes are single-use.** The highest time step an account has spent is stored (`lastTotpStep`),
and anything at or below it is refused. Without that, a plain "is this code right" check leaves a
90-second window in which a phishing proxy can relay a code the human just typed. The update is
conditional on the value that was read, so two logins racing the same code cannot both succeed —
the loser is told `That code has already been used.`

Recovery codes are 10 characters from a 30-symbol alphabet (~49 bits each), stored as SHA-256
digests and removed from the array when redeemed. The alphabet excludes I, L, O, U, 0 and 1
because these get read off paper.

Requesting a TOTP code does reveal that the password was correct. That is unavoidable: a second
factor cannot be requested without admitting the first one passed.

### API keys

Format: `plt_xxxxxxxx.<secret>` — a public prefix and a 256-bit secret.

- The **prefix** is stored in the clear and indexed, so presenting a key costs one lookup. It is
  what appears in audit rows and in the UI; it identifies a key without being one.
- The **whole token** is stored as a SHA-256 digest. Key stretching would buy nothing over 256
  bits of CSPRNG output, and this runs on every authenticated request.
- Comparison is constant-time, and the digest is computed **unconditionally** — an unknown prefix
  and a wrong secret take the same time.
- The plaintext is returned once, at creation, and is not retrievable afterwards.
- Keys may carry an expiry (`expiresInDays`). An expired key returns `token_expired`, not
  `unauthenticated`, so a client can tell "rotate me" from "you are wrong".
- `lastUsedAt` is updated at most once per key per minute, off the request path.

Two things a key deliberately cannot do:

1. **Mint or revoke a key, or change account security settings.** Those routes require an
   interactive session (`via === 'jwt'`); a key gets `Sign in with your password to change account
security settings.` A stolen key therefore cannot bootstrap itself into a wider one.
2. **Act on anything the vocabulary cannot name.** Role-gated routes — user administration, node
   administration, runtime settings, the Prometheus scrape — call `assertScope(auth, null)`, which
   refuses any _restricted_ key outright:
   ```
   $ curl -s localhost:8080/api/v1/system/metrics -H "X-API-Key: <scoped key>"
   {"error":{"code":"forbidden","message":"This API key is not allowed to act on the account itself."}}
   ```
   An unrestricted key (created with an empty scope list) does the same thing its owner can. If
   that is not what you want, do not create unrestricted keys.

---

## Authorisation

### Roles

Three, ranked: `owner` (3) > `admin` (2) > `member` (1). Admins and owners see and act on every
server. A member sees only servers they own or have been invited to.

Roles are stored as strings because SQLite has no enums. On the way out, a row whose role is not
in the union throws rather than degrading to `member` — an unrecognised value must not silently
grant _something_.

### Per-server permissions

Twenty, granted individually to a subuser on a specific server:

```
server.view      server.update    server.delete
power.start      power.stop       power.restart
console.read     console.write
files.read       files.write      files.delete
backups.read     backups.create   backups.restore   backups.delete
schedules.read   schedules.write
settings.read    settings.write
ai.use
```

The default grant for an invited collaborator is "run it, don't destroy it": view, all three power
actions, console read/write, `files.read`, `backups.read`, `schedules.read`, `settings.read`.

Two rules make this hold up:

- **An unknown permission never widens access.** The column is JSON; a string this build does not
  recognise is dropped on read, and an unparseable column yields the empty set — which denies
  everything. A corrupt row becomes a visible outage rather than a silent grant.
- **No relationship means 404, not 403.** A 403 confirms that the server exists. A malformed
  server id returns exactly the same answer as a real one you cannot see, so probing ids tells an
  attacker nothing. The MCP path follows the identical rule, and it is stated in both files
  precisely so they cannot drift.

### API key scopes

The scope vocabulary is the 20 server permissions verbatim, plus two that have no per-server
analogue: `server.create` and `audit.read`. That reuse is deliberate — a key must not be grantable
something a subuser could not be granted.

Authorisation happens **twice** on every call: once against the key's scopes, once against the
per-server permission the caller's account holds. Scope is checked first, before anything touches
the database, so an under-scoped credential learns nothing about which servers exist. Both
surfaces — REST and MCP — parse scopes through the same `lib/scopes.ts`, because a scope system
only one surface consults is not a scope system.

An empty scope list means unrestricted, i.e. "whatever the owning user can do". A scopes column
that cannot be parsed yields the empty _set_, which denies everything: fail closed.

---

## What an AI agent can and cannot do

An agent is a principal, not an exception. It authenticates with an ordinary API key, is
authorised by the same scopes and permissions a human faces, and is audited by name.

### Can

Create servers, start/stop/restart/kill them, delete them, send console commands, read logs and
search them, read metrics, assemble crash evidence, list and kick/ban/whitelist players, read the
blueprint catalogue, search mods, read mod detail, list installed mods, check for updates, read
addresses, probe reachability, and **propose** a mod.

### Cannot

- **Install, update or remove any file.** There is no tool for it. `mcp/tools.ts` imports only the
  read-only half of the mod service and only `propose` from the proposal service; `applyResolution`,
  `removeInstalledMod` and `approve` — the three symbols that can put bytes on a server's disk —
  appear nowhere in the module. This is enforced by the dependency graph and checked by a test,
  not left to reviewer memory.
- **Act without confirmation on anything destructive.** `delete_server` needs `confirm: true` _and_
  `confirmServerName` matching exactly; `power_server` needs `confirm: true` for stop, restart and
  kill; `ban_player` needs `confirm: true`. Called without them the tool changes nothing and
  returns a sentence describing what would have happened.
- **Escalate.** A session's authority is fixed to one principal when it is created. No tool takes
  an "act as" argument. Presenting a different key against an existing MCP session is refused
  rather than honoured, because session ids travel in headers and end up in client logs.
- **Use a browser session.** MCP accepts API keys only. A JWT is refused:
  ```
  {"error":{"code":"unauthenticated",
            "message":"MCP requires a Platter API key. Send it as X-API-Key, or as Authorization: Bearer plt_…."}}
  ```
  A stolen access token therefore cannot reach the agent surface at all.

### Audited

Every MCP-initiated write records the client, the account and the revocable key:

```json
{
  "action": "server.created",
  "actorName": "docs-check (Owner via key plt_kN4XJjS7)",
  "targetName": "survival",
  "metadata": {
    "via": "mcp",
    "tool": "create_server",
    "apiKeyId": "key_01KZ…",
    "apiKeyPrefix": "plt_kN4XJjS7",
    "blueprintKey": "minecraft-java"
  }
}
```

Of those three identities, the key is the one you can revoke.

---

## The mod supply chain

A mod jar is arbitrary code the game will execute with the container's privileges. Platter treats
the download path as a supply-chain boundary rather than a file copy.

### Before a byte is written

From [`mods/install.ts`](../apps/api/src/mods/install.ts):

1. **HTTPS only, from an allowlist of hosts per source.** Modrinth downloads must come from
   `cdn.modrinth.com`; CurseForge from `edge.forgecdn.net`, `mediafilez.forgecdn.net` or
   `media.forgecdn.net`. This is the control that makes the rest meaningful — without it the
   installer fetches whatever host the API response names, and the API response is exactly what an
   attacker upstream or on the network path would forge.
2. **A published checksum is required.** No checksum, no install:
   ```
   modrinth did not publish a checksum for some-mod-1.0.jar, so Platter cannot verify it.
   ```
   Refusing is the only honest option. Nothing to verify against means nothing to trust.
3. **The body is hashed while it streams** and compared against the published digest **before**
   the file moves into place. An unverified jar never exists at a path the game will scan.
4. **The staging file lives in the destination directory**, so the final step is a rename on the
   same filesystem — atomic. The game never sees a half-written jar.
5. **The transfer is capped** at 256 MiB, so a hostile `Content-Length` (or none at all) cannot
   fill the node's disk.
6. **The filename is validated, not sanitised.** A name from a third-party API that is not a plain
   basename is rejected outright — quietly rewriting `../../etc/cron.d/x` into something safe would
   hide the fact that a provider handed you a traversal.

### The human approval gate

An agent's proposal is a record, not an action. Two rules make the gate mean something:

**1. A proposal snapshots what the reviewer will be shown.** The full project detail, the chosen
version and the resolved dependency plan are stored at proposal time. If the approval screen
re-fetched from upstream, an attacker who could influence the registry between proposal and
approval would decide what the human reads.

**2. Approval re-reads live state and refuses to install anything that moved.** On approve,
Platter drops the provider cache, re-fetches the project and version, re-resolves dependencies
against the server _as it is now_, and diffs the fields that decide what code runs: checksums,
download URL, filename, dependency set, loaders, game versions, and every jar the plan would
actually write. Cosmetic changes — a renamed project, a new icon — deliberately do not trip the
gate, because a gate that fires on cosmetics is one reviewers learn to click through.

Here is that gate firing, from a real approval after the upstream file hash was changed behind
Platter's back:

```
POST /api/v1/servers/srv_…/proposals/mpr_…/approve   →  409 Conflict

{
  "status": "changed",
  "changes": [
    { "field": "plan",   "material": true,
      "before": "modrinth:gvQqBUqZ → mods/lithium-fabric-0.15.4+mc1.21.1.jar (N08Z8wog, 182064b00e63…)",
      "after":  "modrinth:gvQqBUqZ → mods/lithium-fabric-0.15.4+mc1.21.1.jar (N08Z8wog, 000000000000…)" },
    { "field": "sha512", "material": true, "before": "182064b00e63…", "after": "000000000000…" },
    { "field": "sha1",   "material": true, "before": "7d82a004403b…", "after": "111111111111…" }
  ],
  "digest": "62402b410f2068e0e5af86c9b86ad1fc20dd783e4d677dfacc88ad366dfa06ed"
}
```

**Nothing was installed.** The proposal is flagged with `driftDetectedAt`, and approving requires
passing the _new_ digest back as `acknowledgedDigest` — which is the reviewer stating, in the
protocol, that they read what changed. The dependency plan is part of the signed set for a
specific reason: a dependency pinned to `*` re-resolves at approval time, so without it a
dependency that published a new jar between propose and approve would install silently with
`changes: []`.

Approving requires `files.write` on the server — never `ai.use`, which is all proposing needs.
That separation is what lets you hand an agent the ability to suggest without the ability to
change anything.

### What this does not do

It verifies **identity**, not **intent**. If the jar you approved is the jar the registry
published, and the registry's account was compromised such that the _original upload_ was
malicious, every check above passes. Read the licence, the source link, the maintenance history
and the download count before approving — that is why `get_mod` returns all of them and why the
review screen shows them.

---

## Input handling

Notes on the paths where untrusted input meets something dangerous.

**File manager.** Every path starts as a client string. The shared schema rejects `..` segments
and NUL bytes, but that is lexical. The real boundary is `resolveServerPath`, which canonicalises
with `fs.realpath` and re-checks containment _after_ symlinks resolve — because a symlink planted
inside the volume by an uploaded mod, a careless plugin, or the game itself can point anywhere,
and every subsequent `fs` call would follow it. Writes are atomic (write-then-rename), so a crash
mid-save cannot truncate a config.

**Console commands.** A command may not contain a newline. Container stdin is line-oriented, so a
second line would be a second command that nothing authorised and nothing audited. Every command
is written to the audit log with the caller's identity.

**Regular expressions from callers.** `get_logs` and `search_logs` compile a caller-supplied
pattern. It is length-capped at 200 characters and always runs over a corpus already bounded to
500 lines, under a 250 ms wall-clock budget with a `filterGaveUp` flag in the response. A
catastrophically backtracking pattern costs a slow response, not a wedged process.

**Backups.** The archive's SHA-256 is recorded at write time and verified before a restore
touches anything; a mismatch is refused with `That backup archive failed its checksum check and
will not be restored.` Extraction runs in `strict` mode. A backup with no recorded checksum
cannot be restored at all.

**Request ids.** A client-supplied `X-Request-Id` is echoed into responses and logs, so it is
constrained to `[A-Za-z0-9._:-]{1,128}`; anything else is replaced with a generated id. An id is a
correlation handle, not a place to inject newlines into your log stream.

**Response headers.** Helmet sets a CSP with `default-src 'self'`, `frame-ancestors 'none'`,
`object-src 'none'`, and HSTS in production. CORS defaults to same-origin only; there is no
wildcard path, because reflecting arbitrary origins with credentials enabled is a session-theft
hole. `script-src` includes `'unsafe-inline'` — the Swagger UI at `/docs` injects its initialiser
inline — which is a genuine weakening of the XSS defence, bounded by the same-origin default on
everything else. If you would rather not carry it, block `/docs` at your reverse proxy; the API
does not need it.

**Body limits.** 2 MiB for JSON. File uploads bypass it and stream through multipart with a 2 GiB
per-file ceiling.

---

## Logging and redaction

Redaction is configured once, in [`logger.ts`](../apps/api/src/logger.ts), rather than at each
call site — credentials reach a logger through more routes than you expect: a validation error
echoing a body, a request log, a driver error carrying its own headers.

**Always redacted** (replaced with `[redacted]`, never merely omitted):

```
req.headers.authorization      req.headers.cookie      req.headers["x-api-key"]
res.headers["set-cookie"]
password   newPassword   currentPassword   passwordHash
token      accessToken   refreshToken
totpSecret recoveryCodes
*.password *.token       *.passwordHash    *.totpSecret
```

**What the audit log records.** 39 action types across auth, users, servers, files, backups,
schedules, nodes, API keys, AI and settings. Each row carries the action, actor id and _name_
captured at write time (so the entry still names them after the account is deleted), target type
and id and name, action-specific metadata, source IP, user agent, and a timestamp. Metadata is
capped at 8 KiB and clipped rather than rejected — an audit row is evidence, not a document.

Failed logins are recorded with a reason (`unknown_email`, `bad_password`, `bad_totp`,
`suspended`). API key creation records the exact scope list granted. Every MCP write records the
tool, the key id and the key prefix.

**Writing an audit row never fails an action.** If the write throws, it is logged loudly and the
action still succeeds — telling a user their deletion failed when it did not is a lie that
provokes a destructive retry. A dropped entry is a monitoring problem, not a correctness one.

**Read access to the audit log** needs authentication, and an API key needs the `audit.read`
scope. What you then see is scoped by role rather than by a gate: an admin or owner sees every
entry, and a member sees only entries targeting servers they own. Export (`/audit/export`) follows
the same rule and streams newline-delimited JSON rather than buffering.

**What is not redacted, and you should know it.** Server config variables marked `password` in a
blueprint (RCON passwords, admin passwords) are stored in the database in plaintext, because the
game needs them as environment variables. They are redacted in every API response — `get_server`
returns `[redacted]` and lists the affected keys in `redactedVariables` — but anyone with the
database file has them. Console output is not scrubbed: if a player types a password into chat, it
is in the log buffer and in the container's logs.

---

## Hardening checklist

In rough order of how much each one buys you.

1. **Do not expose port 8080 to the internet.** Put it behind TLS on a reverse proxy, or behind a
   VPN/Tailscale, or leave it on the LAN. See [DEPLOYMENT.md](DEPLOYMENT.md#reverse-proxy-and-tls).
2. **Claim the instance immediately.** A fresh install has no accounts and the first account
   created becomes owner regardless of `REGISTRATION_ENABLED`. Do not leave that window open on a
   reachable port.
3. **`JWT_SECRET` from `openssl rand -base64 48`,** in a `.env` that is `chmod 600` and not in
   git. Rotating it signs everyone out, which is the correct response to a suspected leak.
4. **Enable TOTP on every owner and admin account.** This is the single largest per-account win.
5. **Leave `REGISTRATION_ENABLED=false`.** Invite people; do not let the internet enrol itself.
6. **Rootless Docker**, or failing that a socket proxy. See [above](#the-docker-socket-is-root).
7. **Scope every API key, and give it an expiry.** A key for a monitoring scrape needs nothing but
   admin read; a key for an agent needs `server.view`, `console.read` and `ai.use`, not
   `server.delete`.
8. **Give collaborators subuser grants, not admin.** Admin is global and sees everything.
9. **Set `TRUST_PROXY`** if and only if a proxy you control sets `X-Forwarded-For`. Without it
   every rate-limit bucket and audit row records the proxy's address, so one attacker exhausts the
   login budget for everyone; with it set wrongly on a directly exposed instance, the address is
   attacker-controlled.
10. **Do not forward RCON.** Platter binds it to loopback on a local node for you; do not undo
    that at the router.
11. **Back up `platter.db` and `.env` together.** See
    [DEPLOYMENT.md](DEPLOYMENT.md#backing-up-platter-itself).
12. **Read the audit log occasionally.** It is there to be read.
13. **Keep the image current.** Game images are pinned per blueprint and updated by upgrading
    Platter.

---

## What Platter does not protect you from

Repeated at the end because it is the part people skip.

- Docker socket access is root on the host, and no configuration inside Platter changes that.
- An owner or admin account is unbounded within the panel. The audit log is a record, not a
  restraint.
- An approved mod runs with the game container's privileges. Approval is the trust boundary.
- RCON and the game query protocols have no transport security; game protocol exploits are the
  game's problem.
- Rate limits are anti-credential-stuffing, not anti-DDoS.
- Anyone with the database file has your servers' configured passwords.
- There is no secret management, no HSM, no envelope encryption. `JWT_SECRET` is an environment
  variable and `platter.db` is a file.

---

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through GitHub's [Security
Advisories](https://github.com/thekozugroup/Platter/security/advisories/new) on the repository,
which creates a private thread visible only to the maintainers.

Please include:

- What an attacker can do, and what they need to already have (an account? a valid API key? LAN
  access?).
- Steps to reproduce, ideally against a `DEFAULT_NODE_DRIVER=mock` instance so nothing real is
  touched.
- The commit or image tag you tested.
- Your assessment of severity, and why.

What to expect: an acknowledgement, a fix or an explanation of why it is working as intended, and
credit in the release notes unless you would rather not have it. Please give a reasonable window
before disclosing publicly.

**Out of scope**, because they are documented properties rather than bugs:

- "The Docker socket gives root on the host." Yes — see [above](#the-docker-socket-is-root).
- "An admin can read every file." Yes, that is what the role is.
- "An approved mod can do anything." Yes. Approval is the trust boundary.
- "Rate limits do not stop a distributed flood." Correct, and not their purpose.

In scope and genuinely wanted: anything that lets a caller act beyond their scopes or permissions,
any path that installs a file without a human approval, any way to read another user's servers or
secrets, any escape from the file-manager sandbox, any way to reach the MCP surface with a browser
session token, and anything that makes an audit entry wrong about who did what.
