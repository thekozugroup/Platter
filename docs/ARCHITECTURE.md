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

## 2. Language choice: TypeScript, and the Rust detour we backed out of

The backend is **TypeScript on Node 22** (Fastify, Prisma, dockerode).

We spent part of a build cycle moving it to Rust and then reverted. That is worth recording
honestly, because the reasoning applies to anyone tempted to try it again.

**The case for Rust was real but narrow.** A statically linked binary makes the runtime image a
base layer plus one file, which serves the "easily deployable" promise; the daemon idles in tens
of megabytes instead of low hundreds; there are no collector pauses on the log-streaming path;
and memory safety matters in code that parses untrusted input. None of that was wrong.

**The case against it was decisive:**

- **It does not make games faster.** A game server's performance is entirely its own image and
  the host CPU. Nothing in a control plane can influence it. The performance argument for Rust
  here was always about the panel's own footprint, never about Minecraft, and the panel is not
  the bottleneck on any realistic box.
- **One language beats two.** The web client is TypeScript. A TypeScript backend shares the
  domain types, the zod schemas, the validation rules, the tooling and the mental model with it.
  For a small team, that is a larger and more durable win than a smaller container image.
- **Maintainability and iteration speed are features.** Slower builds, a stricter compiler and a
  smaller contributor pool are real costs paid on every future change, not once.
- **The ecosystem is here.** dockerode, Prisma, the Modrinth clients, RCON libraries and the
  Fastify plugin surface are mature and well-trodden for exactly this use case.

The deployment gap is smaller than it looks: a multi-stage build with production-only
dependencies lands in the low hundreds of megabytes, which is unremarkable for a self-hosted
service that is already pulling multi-gigabyte game images.

**What it cost:** the reversal was cheap because everything was in git. The API was restored
from history intact. The design system, the web foundation and the documentation were never
language-specific and were untouched throughout.

**If Rust ever returns**, it should be for a specific measured bottleneck — and there is not one
today.

---

## 3. Package layout

```
packages/shared     Domain vocabulary, the lifecycle state machine, error codes, and the
                    zod schemas for every request and response. Imported by BOTH the API
                    and the web client, so the wire format has one source of truth and a
                    contract change is a type error rather than a runtime surprise.
apps/api            Fastify server. Auth, routes, WebSocket console, orchestration,
                    scheduler, mods, MCP endpoint. Serves the built SPA, so the whole
                    product is one origin and one container.
  src/orchestration   OrchestrationDriver interface; Docker (dockerode) and Mock
                      implementations, log fan-out, stats sampling.
  src/services        Lifecycle, allocations, files, backups, scheduler, players, mods.
  src/blueprints      The game catalogue, Minecraft first.
  src/mcp             MCP server exposing Platter to AI agents.
  src/routes          The HTTP surface.
apps/web            React SPA — Shark UI components on the Ghost design system.
```

Dependencies flow one way: `packages/shared` knows nothing about either app. The
`OrchestrationDriver` interface exists so the Mock driver is a complete stand-in — CI and the
entire test suite run with no Docker daemon and no network.

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
