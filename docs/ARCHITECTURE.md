# Platter architecture

Platter is a **control plane**. It starts, stops, configures, monitors and backs up game
servers that run as Docker containers. It does not implement any part of a game.

---

## 1. Scope boundary — what Platter is not

This section exists because the boundary is easy to drift across, and crossing it would be a
serious mistake.

**Platter does not reimplement Minecraft, or any game server.** Servers run the container
images the community already runs and trusts — `itzg/minecraft-server`,
`itzg/minecraft-bedrock-server`, `lloesche/valheim-server`, `factoriotools/factorio` and so on,
each pinned to a tag. Platter's job stops at the container boundary.

Specifically **out of scope, permanently**:

- Any reimplementation of the Minecraft server, its world format, chunk storage, entity
  simulation, or the client-facing game protocol.
- A custom server jar, a fork of Paper/Fabric/Forge, or a patched runtime.
- Anything that would make a Platter-managed server behave differently from the same image run
  by hand. An operator must be able to `docker run` the same image and get the same server.

**In scope**, and the reason there is any game-specific code at all — every item here is
*administration*, the same operations an operator performs from a terminal:

| Component | What it is | Why it is not "reimplementing Minecraft" |
| --- | --- | --- |
| RCON client | The standard remote-console protocol | It is how you run `whitelist add` without attaching to the container. A client, not a server. |
| Query/ping client | Read-only player counts | Same protocol any server-list website speaks. |
| `server.properties` reader/writer | Config file parsing | It is an INI-ish text file. Editing it is what a settings page does. |
| Log pattern matching | Regex over stdout | Deriving "ready" / "crashed" / "player joined" from output the server already prints. |
| Version and loader matrix | Which loaders support which versions | Metadata used to check mod compatibility before downloading. |

If a future change requires modifying how the game itself executes, that is the signal that it
belongs upstream in the image, not in Platter.

---

## 2. Why Rust, and where it actually helps

Rust is used for the control plane. The honest case for it here is **not** "games run faster" —
the game server's performance is entirely determined by its own image and the host's CPU, and
Platter cannot influence it. Nothing in this codebase makes Minecraft tick faster.

The real, measurable benefits, in the order they matter:

1. **Deployment simplicity.** A statically linked binary means the runtime image is a base
   layer plus one file — no language runtime, no dependency tree shipped to production. "Easily
   deployable" is the product's core promise, and this is the largest single contribution to it.
2. **Memory footprint.** A control panel is meant to be the *cheap* process on the box; every
   megabyte it holds is a megabyte a game server does not get. A Rust daemon idles in tens of
   megabytes, where a managed-runtime equivalent idles in the low hundreds. On a 4 GB VPS
   running two Minecraft servers, that difference is real.
3. **No GC pauses on streaming paths.** The daemon continuously demultiplexes container log
   streams, fans them out to WebSocket subscribers, and samples resource stats. This is
   sustained, allocation-heavy, latency-sensitive I/O — exactly where a collector pause shows
   up as a stuttering console.
4. **Memory safety in a network-facing daemon** that parses untrusted input: container log
   frames, uploaded archives, mod metadata from third-party APIs, and RCON responses. This is
   the code most likely to be attacked, and the class of bug most expensive to get wrong.

Where Rust is **not** claimed to help: request throughput (the API is nowhere near a
bottleneck at self-hosting scale), and developer iteration speed (it is worse — builds are
slower and the contributor pool is smaller). Those are accepted costs, not hidden ones.

The web client stays TypeScript/React. There is no benefit to Rust in the browser here, and a
WASM UI would cost accessibility and bundle size for nothing.

---

## 3. Crate layout

```
crates/
  platter-core      Domain types, the lifecycle state machine, errors, traits.
                    Generates the client's TypeScript types via ts-rs, so the wire
                    format has exactly one source of truth.
  platter-db        sqlx + SQLite (Postgres-portable). Migrations and repositories.
  platter-runtime   ContainerRuntime trait; Docker (bollard) and Mock implementations.
                    Log fan-out, stats sampling, lifecycle, crash supervision.
  platter-net       Port allocation, mDNS/Bonjour advertisement, SRV records,
                    reachability probing, optional UPnP.
  platter-games     Blueprint catalogue and the Minecraft administration layer
                    (RCON, query, server.properties, players, health).
  platter-mods      Modrinth and CurseForge clients, dependency resolution,
                    verified downloads, and the human-approval proposal workflow.
  platter-api       axum HTTP + WebSocket surface. Auth, routes, OpenAPI.
                    Serves the built SPA, so the product is one origin.
  platter-mcp       MCP server (stdio + streamable HTTP) exposing Platter to AI agents.
  platter-cli       The `platter` binary: serve, mcp, migrate, seed, admin, doctor.
apps/web            React SPA — Shark UI components on the Ghost design system.
```

Dependencies flow one way: `core` knows nothing about the others; `api` and `mcp` depend on the
subsystems; nothing depends on `api` or `mcp`. The `ContainerRuntime` and `ModRegistry` traits
live in `core` precisely so that the Mock runtime is a complete stand-in — CI and the entire
test suite run with no Docker daemon and no network.

---

## 4. The AI story, and why it is safe

Platter exposes an **MCP server**, so an agent can create servers, read logs, monitor status
and suggest mods. The property that makes this acceptable to point at real infrastructure:

**An agent can propose a mod. It cannot install one.**

`propose_mod` snapshots the full mod detail and the chosen version at proposal time and creates
a pending record. A human reviews it in the web UI — description, images, author, license,
downloads, dependencies — and approves or rejects. Approval re-resolves against current state
and surfaces any change since the proposal was raised, so the human cannot approve one thing
and get another. The MCP crate has no code path to the installer at all; this is enforced by
the dependency graph, not by convention.

Destructive tools require explicit confirmation arguments, every call is authorised against the
API key's scopes and the same per-server permissions a human faces, and everything is audited
with the agent's identity. An agent is a principal, not an exception.

---

## 5. Addressing: why servers have names, not IP:port

Typing `192.168.1.50:25565` is the first thing that makes self-hosting feel like work.

Platter allocates host ports automatically from a configured range and advertises every running
server over **mDNS** as `<slug>.platter.local`, alongside a `_minecraft._tcp` **SRV record**.
The Minecraft Java client performs an SRV lookup, so with that record a player types
`survival.platter.local` — no port at all.

This works with zero configuration on macOS and iOS, where Bonjour is built in, and on Linux
and Windows with mDNS available. For a public deployment, the operator points a wildcard record
at the host and Platter renders the exact zone-file lines to paste.

mDNS failing never prevents a server from starting; the address simply falls back to `host:port`.
