# Architecture

How Platter is put together, and why.

## The shape of it

```
                      ┌──────────────┐        ┌──────────────┐
                      │  apps/web    │        │  apps/mcp    │
                      │  Next.js UI  │        │  MCP server  │
                      └──────┬───────┘        └──────┬───────┘
                             │                       │
                             └───────────┬───────────┘
                                         │
                            ┌────────────▼────────────┐
                            │     packages/core       │
                            │  lifecycle · Docker ·   │
                            │  RCON · backups ·       │
                            │  supervisor             │
                            └──┬─────────┬─────────┬──┘
                               │         │         │
                  ┌────────────▼──┐  ┌───▼─────┐ ┌─▼──────────────┐
                  │  packages/db  │  │  mods   │ │  diagnostics   │
                  │  SQLite       │  │ Modrinth│ │  log rules     │
                  │  (Drizzle)    │  │ CurseFo.│ │                │
                  └───────┬───────┘  └────┬────┘ └───────┬────────┘
                          └───────────────┼──────────────┘
                                  ┌───────▼────────┐
                                  │ packages/shared│
                                  └────────────────┘
                                          │
                            ┌─────────────▼─────────────┐
                            │      Docker daemon        │
                            │  itzg/minecraft-server ×N │
                            └───────────────────────────┘
```

Dependencies flow one way. Nothing in `packages/` imports from `apps/`. Both apps call the same
functions in `core`, which is what stops the UI and the AI from drifting apart in what they allow
— a mod installed by a human and a mod installed by an assistant go through identical code.

## Two sources of truth, reconciled

The database records **intent**: this server should exist, with this configuration. Docker records
**reality**: this container is running, or it isn't.

They drift constantly, and every way they drift is normal:

- Platter was closed when a server crashed.
- Someone ran `docker stop` by hand.
- The machine rebooted and Docker restarted containers on its own.
- A mod wedged the JVM and the health check went red.

A supervisor (`packages/core/src/supervisor.ts`) reconciles them every few seconds and **believes
Docker**. Without this, the dashboard confidently shows "Running" next to a container that has
been dead for hours — which is the state most panels leave you in.

The interesting part is not the steady states but the transitions. A dead container is a *crash*
if the previous status was `running`, and a *successful stop* if it was `stopping`. Same Docker
signal, opposite meanings; comparing against the stored status is what tells them apart.

## What runs where

Platter is one Node process. The Next.js server hosts the UI, its HTTP API, and — via
`instrumentation.ts` — the supervisor. There is no separate worker to run, no queue to provision,
and no second thing to remember to start.

That is a deliberate trade. A separate daemon (Pterodactyl's Wings model) buys multi-node
support; Platter is explicitly a single-machine tool, so the complexity buys nothing and the
simplicity is worth a great deal. The one process is guarded on `globalThis` so Next's
development-mode module reloading cannot start a second supervisor and double every scheduled
backup.

The MCP server runs separately (usually spawned by an AI client over stdio) and shares the same
SQLite database and Docker client through the same `Context`.

## Safety rails

Three things constrain what a bug can do:

**Label gating.** Every destructive Docker call goes through `packages/core/src/docker/guard.ts`,
which inspects the container first and refuses to act unless it carries `platter.managed=true`.
The cost is one `inspect` per operation — a rounding error next to `docker stop` — and it converts
a whole class of bug from "destroyed unrelated containers" into "returned an error".

**Path containment.** Anything that turns user input into a path goes through `resolveWithin`,
which normalises, checks, resolves symlinks, and checks *again*. The second check is the one that
matters: `mods/evil` can be a symlink to `/etc`, and the first check cannot see that. Archive
extraction additionally rejects entries and link targets that escape.

**Container hardening.** Game containers drop capabilities, set `no-new-privileges`, get
mandatory memory/CPU/pids limits, run with swap disabled, get capped log files and a `noexec`
tmpfs, and sit on a dedicated bridge network. The baseline is Wings', which is the strongest among
existing panels.

## Choices worth explaining

### Java versions are computed, never asked

Every other panel makes you pick, and picking wrong produces
`UnsupportedClassVersionError: class file version 65.0` — the most-asked support question across
all of them. The Minecraft version determines the floor, so `selectImage()` computes it, including
the Forge-below-1.18 exception that needs Java 8 even though the Minecraft version wouldn't.

### Minecraft versions are never parsed

Versions moved to calendar numbering. A single list now contains `1.7.10`, `1.21.11`, `26.1`,
`26.2-rc-1` and `22w13a`, and no comparator over those strings sorts them correctly. `VersionIndex`
answers ordering questions by *position* in Modrinth's published list, which is newest-first and
authoritative. Parsing exists only as an explicitly best-effort fallback for the cold-start case.

### RCON is a first-class channel, not a fallback

Everyone else drives Minecraft through the console: write to stdin, scrape stdout. That breaks
when a mod reconfigures log4j, it cannot match a response to the command that produced it, and it
dies with the main thread.

RCON gives structured request/response, survives a wedged console because the network thread is
separate, and — critically — it is what makes hot backups possible.

### Backups snapshot a running world

```
save-off          stop the auto-save thread
save-all flush    force every dirty chunk to disk AND WAIT
→ archive         the on-disk world is now internally consistent
save-on           resume
```

The `flush` argument is load-bearing. Plain `save-all` returns before the write completes, so the
archive catches a half-written region file — which is exactly the corruption Crafty's own docs
blame on compression. The failure path re-enables saves unconditionally; leaving them off means
the world silently stops persisting, which is worse than a failed backup.

Restore extracts to a staging directory and swaps in with two renames. Wipe-then-extract, the
obvious implementation, destroys the world if extraction dies halfway.

### Ports are a ledger, not a scan

Scanning `docker ps` races when two servers are created at once, and cannot see ports held by
processes Platter has never heard of. So: a `port_allocations` table with a unique index, a kernel
probe on `0.0.0.0` before committing, and the constraint arbitrating ties. Allocation happens in
the same transaction as the server insert, because the ledger has a foreign key to it.

### SSE, not WebSockets

Log and event streams are one-directional. `EventSource` reconnects on its own, survives proxies
that mangle upgrades, and needs no protocol of its own. Three details that are easy to miss:
`X-Accel-Buffering: no` or a proxy buffers the stream; a heartbeat every 25s or an intermediary
reaps the connection; and unsubscribe on `cancel` or every closed tab leaks a listener.

### The AI proposes; a human decides

Reading is unrestricted. Anything that changes a server writes a proposal row, elicits a decision
through MCP's elicitation flow, and only then acts. Decline and cancel are treated identically —
acting on a dismissed dialog is exactly the behaviour that would make people stop trusting it.
There is no auto-approve flag, and a client without elicitation support gets a refusal rather than
a silent proceed.

Every decision is recorded next to the proposal that produced it, so "the AI installed something
and now the server is broken" has an answer.

## Adding a game

Games are described by a manifest: image, environment mapping, ports, health check, log patterns.
Adding one should not require touching the orchestrator. If it does, that is a bug in the
orchestrator.

Minecraft is the only one implemented, and the abstraction is deliberately shallow — one real
implementation is honest, two would let us claim generality we have not tested.
