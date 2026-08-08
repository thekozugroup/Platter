<div align="center">

# Platter

**Simple, clean, easily deployable game servers driven by AI.**

Self-hosted control panel for game servers. Minecraft-first, with the whole thing
drivable by an AI agent over MCP — including mod suggestions that a human approves.

[Quick start](#quick-start) · [What it does](#what-it-does) · [AI and MCP](#ai-and-mcp) ·
[Architecture](docs/ARCHITECTURE.md) · [Design](docs/DESIGN.md)

</div>

---

## Why

Running a game server for friends is mostly not about the game. It is port forwarding,
`server.properties`, a JVM flag someone copied off a forum in 2016, and a mod that silently does
nothing because it went in the wrong folder.

Platter is the layer that handles those, and stays out of the way of the game itself. It runs the
same community container images you would run by hand — it does not fork, patch or reimplement
any part of a game server. See the [scope boundary](docs/ARCHITECTURE.md#1-scope-boundary--what-platter-is-not).

## Quick start

```bash
git clone https://github.com/thekozugroup/Platter.git
cd Platter
cp .env.example .env

openssl rand -base64 48                 # paste as JWT_SECRET
stat -c '%g' /var/run/docker.sock       # paste as DOCKER_GID

docker compose up -d
docker compose logs platter | grep -i password   # the generated owner password, printed once
```

Open <http://localhost:8080>. That is the whole install: one container and a volume.

> **Docker socket access is equivalent to root on the host.** Platter needs it to manage
> containers. Read [DEPLOYMENT.md](docs/DEPLOYMENT.md) before exposing an instance to the
> internet, and prefer a rootless daemon or a socket proxy for anything multi-tenant.

## What it does

### Servers people can actually reach

Ports are allocated automatically, and every server is advertised over mDNS as
`<name>.platter.local`. For Minecraft, Platter also publishes an SRV record — so a player types

```
survival.platter.local
```

with **no port at all**. It works with zero configuration on macOS and iOS, where Bonjour is
built in. If mDNS is unavailable the address falls back to `host:port` and nothing breaks.

There is a reachability probe that tells you the truth: *"reachable on your local network but not
from the internet"* is the common real answer, and Platter says so rather than showing a green
tick.

### Minecraft, properly

The server type is the most consequential choice a new operator makes, so Platter explains it
instead of offering a dropdown of twenty jar names. Supported via `itzg/minecraft-server`:

| Group | Types |
| --- | --- |
| Vanilla | `VANILLA` |
| Plugins (Bukkit API) | `PAPER` `PURPUR` `SPIGOT` `BUKKIT` `FOLIA` `PUFFERFISH` `LEAF` |
| Mod loaders | `FABRIC` `FORGE` `NEOFORGE` `QUILT` |
| Hybrid mods + plugins | `MOHIST` `MAGMA` `ARCLIGHT` `KETTING` `CRUCIBLE` |
| Modpacks | `AUTO_CURSEFORGE` `MODRINTH` `FTBA` |
| Other | `SPONGEVANILLA` `LIMBO` `GLOWSTONE` `CUSTOM` |

Platter knows which of those take **mods** (`mods/`) and which take **plugins** (`plugins/`), so a
Fabric mod never lands in a Paper plugins folder where it would quietly do nothing.

Also: RCON and query clients, `server.properties` editing that preserves your comments and key
order, player management (whitelist, ops, bans, kick) that falls back to log-derived history when
RCON is off, and TPS where the server reports it — reported as unavailable where it does not,
rather than invented.

Eleven other games ship alongside: Valheim, Palworld, Rust, Terraria, Factorio, Satisfactory,
Enshrouded, Project Zomboid, Counter-Strike 2, Don't Starve Together, and Minecraft Bedrock.

### Everything else

- **Console** — live, streamed, with history and search. One connection per server, fanned out.
- **Files** — browse, edit, upload, compress. Writes are atomic, so a crash mid-save never
  truncates a config.
- **Backups** — streamed `tar.gz` with a SHA-256 verified before any restore, retention rules,
  and a save-flush/resume pair so a world is not archived mid-write.
- **Schedules** — cron with a plain-English preview and the next few run times. Nobody should
  have to parse `0 4 * * *` in their head.
- **Monitoring** — CPU, memory, disk, network, players and TPS over time, with rollup tiers so a
  long-running install does not fill the disk with samples.
- **Mods** — Modrinth and CurseForge, with dependency resolution and a hash check before any jar
  is put in place.
- **Users** — roles, per-server permissions for collaborators, scoped API keys, TOTP, audit log.

## AI and MCP

Platter exposes an **MCP server** over stdio and streamable HTTP, so Claude or any MCP client can
create servers, read logs, diagnose a crash, watch metrics and manage players.

```jsonc
// Claude Desktop / any MCP client
{
  "mcpServers": {
    "platter": {
      "command": "docker",
      "args": ["exec", "-i", "platter", "node", "apps/api/dist/mcp/cli.js"],
      "env": { "PLATTER_API_KEY": "plt_..." }
    }
  }
}
```

**The agent can propose a mod. It cannot install one.**

`propose_mod` snapshots the full mod detail and the chosen version at proposal time and creates a
pending record. You review it in the web UI — description, images, author, license, downloads,
dependencies — and approve or reject. Approval re-resolves against current state and surfaces
anything that changed since, so you cannot approve one thing and get another.

This is enforced structurally, not by convention: the MCP module has no code path to the
installer. Destructive tools need an explicit confirmation argument, every call is authorised
against the API key's scopes and the same per-server permissions a human faces, and everything is
audited with the agent's identity.

## Configuration

Everything is environment variables; see [`.env.example`](.env.example) for the annotated set.
The ones that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | — | **Required.** `openssl rand -base64 48` |
| `PUBLIC_HOST` | `127.0.0.1` | The address players use. Set this deliberately. |
| `PORT_RANGE_START/END` | `25000`–`25999` | Host ports Platter may allocate |
| `DOCKER_GID` | `999` | `stat -c '%g' /var/run/docker.sock` |
| `ANTHROPIC_API_KEY` | — | Optional. AI features hide cleanly when unset. |
| `REGISTRATION_ENABLED` | `false` | Off by default — invite users from the admin area |
| `DATABASE_URL` | SQLite | Postgres supported; see DEPLOYMENT.md |

## Development

```bash
pnpm install
pnpm --filter @platter/shared build
pnpm --filter @platter/api exec prisma migrate deploy
pnpm dev            # API on :8080, web on :5173

pnpm verify         # typecheck + lint + test
```

The orchestration layer sits behind a driver interface with a faithful in-memory mock, so the
entire test suite and CI run with **no Docker daemon and no network**:

```bash
DEFAULT_NODE_DRIVER=mock pnpm test
```

## Project layout

```
packages/shared   Domain vocabulary, lifecycle state machine, zod schemas — imported by
                  both sides, so the wire format has one source of truth
apps/api          Fastify server: auth, routes, console WebSocket, orchestration,
                  scheduler, mods, MCP. Serves the built SPA, so it is one origin
apps/web          React SPA — Shark UI components on the Ghost design system
docs/             Architecture, design contract
```

## Contributing

Issues and pull requests welcome. `pnpm verify` must pass. Adding a game is usually a
[blueprint](apps/api/src/blueprints/) — data, not code.

## License

MIT © The Kozu Group
