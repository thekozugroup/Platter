# Changelog

Notable changes to Platter. This file is written for someone deciding whether to install or
upgrade, so it says what changed and what it means rather than listing commit subjects.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Platter uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, minor versions may
change behaviour — the entry will say so.

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-08-14

First public release. Everything below is new, so this entry describes what Platter _is_
rather than what moved.

### Servers

- **Twelve games** out of the box: Minecraft (Java and Bedrock), Valheim, Palworld, Rust,
  Terraria, Factorio, Satisfactory, Enshrouded, Project Zomboid, Counter-Strike 2 and Don't
  Starve Together. Each is a [blueprint](apps/api/src/blueprints/) — data, not code — so
  adding a game is a pull request that touches one file.
- **Minecraft properly.** Twenty-two server types via `itzg/minecraft-server`, grouped and
  explained instead of offered as a dropdown of jar names. Platter knows which take **mods**
  (`mods/`) and which take **plugins** (`plugins/`), so a Fabric mod never lands in a Paper
  plugins folder where it would quietly do nothing.
- **Lifecycle behind a driver interface** with a faithful in-memory mock, which is why the
  whole test suite and all of CI run with no Docker daemon and no network.
- `server.properties` editing that preserves your comments and key order. RCON and query
  clients. Player management — whitelist, ops, bans, kick — that falls back to log-derived
  history when RCON is off.

### Reaching your servers

- Ports are allocated automatically from a configurable range.
- Every server is advertised over **mDNS** as `<name>.platter.local`, and for Minecraft
  Platter also publishes an **SRV record**, so a player types `survival.platter.local` with no
  port at all. Zero configuration on macOS and iOS. If mDNS is unavailable the address falls
  back to `host:port` and nothing breaks.
- A **reachability probe that tells the truth.** "Reachable on your local network but not from
  the internet" is the common real answer, and Platter says exactly that rather than showing a
  green tick it cannot justify.

### Operating

- **Console** — live, streamed, with history and search. One upstream connection per server,
  fanned out to every viewer.
- **Files** — browse, edit, upload, compress. Writes are atomic, so a crash mid-save never
  truncates a config.
- **Backups** — streamed `tar.gz` with a SHA-256 verified before any restore, retention rules,
  and a save-flush/resume pair so a world is never archived mid-write.
- **Schedules** — cron with a plain-English preview and the next few run times.
- **Monitoring** — CPU, memory, disk, network, players and TPS over time, with rollup tiers so
  a long-running install does not fill the disk with samples. TPS is reported only where the
  server actually reports it, and marked unavailable elsewhere rather than invented.
- **Users** — roles, per-server permissions for collaborators, scoped API keys, TOTP, and an
  audit log that records who did what.

### Mods

- **Modrinth and CurseForge**, with dependency resolution, compatibility filtering by loader
  and game version, and a **SHA-512 check before any jar is put in place**.
- Two paths, and the interface makes obvious which one you are in. A person browsing presses
  **Add to \<server\>** and it installs — but a plan with a surprise in it (extra dependencies,
  a version change) stops and shows the exact files first, while a plan without one just
  happens. An agent's suggestion arrives as _someone suggested this for you_, with the agent's
  own words quoted and Add / Dismiss at equal weight.
- Registry descriptions are rendered by a small in-house Markdown reader with **no HTML sink at
  all** — no `dangerouslySetInnerHTML`, no `innerHTML`. Registry text reaches the DOM only as
  text nodes, and the two attacker-controlled attributes, `href` and `src`, are restricted to
  http and https.
- Mod artwork is **proxied through Platter** rather than loaded from a registry CDN, so the
  content security policy stays at `img-src 'self'`: your browser never tells Modrinth which
  mods you are reading about, and artwork still loads on a host whose only egress is a proxy.

### AI and MCP

- An **MCP server** over stdio and streamable HTTP with **25 tools**, so Claude or any MCP
  client can create servers, read logs, diagnose a crash, watch metrics and manage players.
- **The agent can propose a mod. It cannot install one.** `propose_mod` snapshots the mod and
  the chosen version and creates a pending record; you review and approve in the web UI, and
  approval re-resolves against current state and surfaces anything that changed since — so you
  cannot approve one thing and get another.
- This is enforced structurally rather than by convention: the MCP module has no code path to
  the installer, and a test parses the MCP source for banned imports, dynamic ones included.
  Destructive tools require an explicit confirmation argument, every call is authorised against
  the key's scopes and the same per-server permissions a human faces, and everything is audited
  with the agent's identity.
- AI features **hide cleanly when `ANTHROPIC_API_KEY` is unset**. Nothing else is affected.

### Installing

- **One command:**
  `curl -fsSL https://raw.githubusercontent.com/thekozugroup/Platter/main/install.sh | sh`
  It preflights Docker and the port, generates a signing secret, reads the Docker socket's
  group instead of guessing `999`, detects this host's address instead of leaving `127.0.0.1`
  where every player would see an address nobody can reach, and waits for the panel to answer
  before telling you it worked. Running it again upgrades in place and never rewrites `.env`.
- **One container and one volume.** The API serves the built client from the same origin, so
  there is no reverse proxy to configure and no CORS policy to get wrong.
- SQLite by default, with Postgres supported. The image runs as an unprivileged user and shuts
  down promptly on `SIGTERM`.

### Known limitations

- **Multi-node is single-node in practice.** The data model and driver interface carry a node
  concept and remote nodes over SSH are implemented, but only the local Docker node has been
  exercised end to end.
- **Mod description images are not rendered.** `img-src` is pinned to `'self'` and the API
  rewrites artwork URLs only for icons and gallery images, not inside free-text bodies, so a
  meaningful `alt` becomes a caption and a bare label is dropped.
- **The mod approval screen still shows blank icons.** It emits raw CDN URLs that the content
  security policy blocks; the browse and detail screens go through the proxy and are fine.
- **`canAdd` defaults to true.** A collaborator holding `ai.use` but not `files.write` sees an
  Add button that will fail with a 403 on the approval half.
- **No email.** There is no password reset, because a fresh self-hosted box has no mail server.
  An administrator resets a password from the admin area.

[Unreleased]: https://github.com/thekozugroup/Platter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/thekozugroup/Platter/releases/tag/v0.1.0
