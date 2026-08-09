# MCP

Platter speaks the [Model Context Protocol](https://modelcontextprotocol.io), so Claude — or any
MCP client — can create servers, read logs, diagnose a crash, watch metrics, manage players, and
_propose_ mods for you to approve.

The design rule, stated once and enforced structurally: **an agent is a principal, not an
exception.** It authenticates with an ordinary API key, is authorised by the same scopes and
per-server permissions a human faces, and is audited by name. And it cannot install a mod — there
is no tool that does, and the module exposing these tools has no import path to the installer.

- [Two transports](#two-transports)
- [Minting a key](#minting-a-key)
- [Connecting over stdio](#connecting-over-stdio)
- [Connecting over streamable HTTP](#connecting-over-streamable-http)
- [Tools](#tools)
- [Resources](#resources)
- [The proposal flow, end to end](#the-proposal-flow-end-to-end)
- [Safety properties, and why each one holds](#safety-properties-and-why-each-one-holds)
- [Troubleshooting](#troubleshooting)

---

## Two transports

|                           | stdio                                                       | Streamable HTTP                                                   |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| How the client reaches it | Spawns a child process                                      | `POST`/`GET`/`DELETE` to `/api/v1/mcp`                            |
| Needs the API running?    | **No** — it talks to the database directly                  | Yes                                                               |
| Credential                | `PLATTER_API_KEY` in the environment                        | `X-API-Key` or `Authorization: Bearer plt_…` on **every** request |
| Best for                  | Claude Desktop and local agent runtimes on the same machine | Remote clients, hosted agents, anything behind your reverse proxy |
| Concurrency               | One process per session                                     | Up to 32 concurrent sessions per Platter process                  |

Both run the same server, expose the same 25 tools, and enforce the same authorisation. Neither
grants authority the other does not.

---

## Minting a key

Settings → API keys in the web UI, or over the API. Sign in first; **a key cannot mint another
key** — that route requires an interactive session.

```bash
ACCESS_TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"…"}' | jq -r .accessToken)

curl -s -X POST http://localhost:8080/api/v1/auth/keys \
  -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"claude-desktop","scopes":["server.view","console.read","ai.use"],"expiresInDays":90}'
```

```json
{
  "id": "key_01KZHGB0D2XFBA69950FCZB80E",
  "name": "claude-desktop",
  "prefix": "plt_LOTE63t8",
  "scopes": ["server.view", "console.read", "ai.use"],
  "expiresAt": "2026-11-06T20:16:56.738Z",
  "token": "plt_LOTE63t8._KbBS0T0HD3iWQ3_TJ4BeSwCGdulnQLGMzj1PIqcglw"
}
```

**`token` is shown once and is never retrievable again.** Only its SHA-256 digest is stored.
`prefix` is the public half — it is what appears in the UI and in audit rows.

### Choosing scopes

An empty `scopes` array means **unrestricted**: the key can do everything its owner can. That is
almost never what you want for an agent. Grant exactly what the tools you intend to allow require:

| If you want the agent to…                                          | Grant                         |
| ------------------------------------------------------------------ | ----------------------------- |
| See servers, blueprints, status, metrics, mods, players, addresses | `server.view`                 |
| Read and search logs, and diagnose crashes                         | `console.read`                |
| Run console commands, kick, ban, whitelist                         | `console.write`               |
| Start servers                                                      | `power.start`                 |
| Stop, kill, or restart servers                                     | `power.stop`, `power.restart` |
| Create servers                                                     | `server.create`               |
| Delete servers                                                     | `server.delete`               |
| Propose mods                                                       | `ai.use`                      |

A read-only diagnostic agent wants `server.view` + `console.read`. An agent that also suggests
mods wants `ai.use` too — and note that `ai.use` grants _proposing_ only. Approving requires
`files.write`, which no MCP tool asks for.

Scopes are fixed when the key is created; there is no edit. To change them, mint a new key and
revoke the old one.

Refusals are explicit and name the missing scope, which is what lets an agent stop rather than
hunt for another route:

```
$ …tools/call {"name":"create_server", …}    # with a key scoped server.view/console.read/ai.use
forbidden: This API key is not scoped for server.create.
```

---

## Connecting over stdio

The client spawns Platter's MCP server as a child process and speaks JSON-RPC over
stdin/stdout. **stdout is the protocol** — every diagnostic goes to stderr, which your client
forwards to its own log.

### Against a container

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "platter": {
      "command": "docker",
      "args": ["exec", "-i", "platter", "node", "apps/api/dist/mcp/cli.js"],
      "env": { "PLATTER_API_KEY": "plt_xxxxxxxx.your-secret-here" }
    }
  }
}
```

`-i` is required: without it the client's stdin never reaches the process.

### Against a development checkout

```json
{
  "mcpServers": {
    "platter": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/Platter/apps/api", "exec", "tsx", "src/mcp/cli.ts"],
      "env": {
        "PLATTER_API_KEY": "plt_xxxxxxxx.your-secret-here",
        "DATABASE_URL": "file:./data/platter.db",
        "JWT_SECRET": "a-secret-of-at-least-32-characters"
      }
    }
  }
}
```

The stdio entry point opens the database directly, so it needs `DATABASE_URL` and does **not**
need the API process to be running. It still requires an API key, because the key is what decides
which servers the session may touch. Launching it locally grants no authority an HTTP caller would
not have.

A relative `DATABASE_URL` like the one above resolves against `apps/api/prisma`, not against the
working directory — Prisma's rule, not Platter's. An absolute `file:/…` path removes the doubt.

### Verifying it by hand

Pipe three frames in and read what comes back:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| PLATTER_API_KEY=plt_… pnpm --dir apps/api exec tsx src/mcp/cli.ts
```

Real output (trimmed), with the log line on stderr where it belongs:

```
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{},"resources":{}},
 "serverInfo":{"name":"platter","title":"Platter","version":"0.1.0"},"instructions":"Platter is a control panel…"},
 "jsonrpc":"2.0","id":1}
…
[platter-mcp] info serving MCP over stdio as owner (key plt_LOTE63t8)
```

A bad or missing key fails before any protocol traffic, with an instruction rather than a stack:

```
Set PLATTER_API_KEY to a Platter API key. Create one under Settings → API keys.
```

---

## Connecting over streamable HTTP

Endpoint: `POST`, `GET` and `DELETE` on **`/api/v1/mcp`**. Responses are Server-Sent Events, so if
you are behind a reverse proxy make sure it is not buffering them — see
[DEPLOYMENT.md](DEPLOYMENT.md#reverse-proxy-and-tls).

```json
{
  "mcpServers": {
    "platter": {
      "type": "http",
      "url": "https://platter.example.com/api/v1/mcp",
      "headers": { "X-API-Key": "plt_xxxxxxxx.your-secret-here" }
    }
  }
}
```

Both `X-API-Key` and `Authorization: Bearer plt_…` are accepted here — the first is what the rest
of Platter uses, the second is what most MCP clients send by default. (The _REST_ API accepts an
API key only in `X-API-Key`.)

### The handshake, by hand

Every request needs `Accept: application/json, text/event-stream`. The session id comes back as a
response header on the initialize.

```bash
KEY='plt_xxxxxxxx.your-secret-here'
BASE=http://localhost:8080/api/v1/mcp
H=(-H "X-API-Key: $KEY" -H 'Content-Type: application/json'
   -H 'Accept: application/json, text/event-stream')

SID=$(curl -s -D - -o /dev/null -X POST $BASE "${H[@]}" -d '{
  "jsonrpc":"2.0","id":1,"method":"initialize",
  "params":{"protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name":"curl","version":"1.0"}}}' \
  | tr -d '\r' | sed -n 's/^mcp-session-id: //Ip')

curl -s -o /dev/null -X POST $BASE "${H[@]}" -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST $BASE "${H[@]}" -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"list_servers","arguments":{}}}'
```

```
event: message
data: {"result":{"content":[{"type":"text","text":"{\"servers\":[],\"page\":1,\"perPage\":25,\"total\":0,\"totalPages\":1}"}],
       "structuredContent":{"servers":[],"page":1,"perPage":25,"total":0,"totalPages":1}},"jsonrpc":"2.0","id":2}
```

Every result carries both `structuredContent` (the real answer, validated against the tool's
output schema) and a `content` text block holding the same JSON, which is the spec-mandated
duplicate for clients that predate structured output. Read `structuredContent`.

### Session rules

- **A session is pinned to the key that opened it.** Session ids travel in headers and end up in
  client logs, so a leaked one must be useless on its own. Presenting a different key against
  someone else's session returns `That MCP session belongs to a different API key.`
- **An unknown session id is a 404, not a fresh session:**
  ```json
  {
    "error": {
      "code": "not_found",
      "message": "That MCP session is not open. Send an initialize request to start a new one."
    }
  }
  ```
  which is the spec's cue for the client to reinitialise.
- **`GET`** opens the server-to-client notification stream and requires an existing session.
  **`DELETE`** ends one. Idle sessions are swept after 30 minutes; a client that comes back
  reinitialises.
- **32 concurrent sessions per process.** Beyond that, `service_unavailable` with `retryable:
true`.
- **A browser session token is refused**, deliberately:
  ```json
  {
    "error": {
      "code": "unauthenticated",
      "message": "MCP requires a Platter API key. Send it as X-API-Key, or as Authorization: Bearer plt_…."
    }
  }
  ```

### Errors

Platter keeps the distinction the MCP spec draws, which most servers collapse:

- **Protocol errors** are JSON-RPC errors — the call never happened. Unknown tool name, invalid
  arguments. `Invalid arguments for power_server: action: Invalid option…`
- **Execution errors** are results with `isError: true` — the call happened and failed. `This
server is installing, so it cannot be started.` That is information the agent should read and
  act on, not a transport failure.

Execution errors are rendered as `code: message`, with per-field detail for validation failures
and a `This is worth retrying.` line when the error is retryable.

---

## Tools

Twenty-five, all validated in both directions: input is parsed before the handler runs, output is
parsed after, so a drifted handler fails at the boundary rather than shipping structured content
that contradicts the schema the agent was given.

`*` marks a required argument. **Scope** is checked before anything touches the database; where a
`serverId` is involved, the same value is also checked as a per-server permission against the
calling account.

### Discovery

| Tool                  | Arguments                                                           | Scope         |
| --------------------- | ------------------------------------------------------------------- | ------------- |
| **`list_servers`**    | `status`, `blueprintKey`, `search`, `page`=1, `perPage`=25 (max 50) | `server.view` |
| **`get_server`**      | `serverId*`                                                         | `server.view` |
| **`list_blueprints`** | `category`, `search`, `feature`                                     | _(none)_      |
| **`get_blueprint`**   | `key*`                                                              | _(none)_      |

`list_servers` returns one page, newest first, with `total` and `totalPages`. Members see servers
they own or were invited to; admins see all.

`get_server` returns everything stored about one server. Blueprint variables declared as passwords
come back as `[redacted]`, with their keys listed in `redactedVariables` so the agent knows they
are set. It does **not** return live CPU/memory (`get_server_status`) or the connection string
(`get_server_address`).

The blueprint tools are ungated on purpose: the catalogue is what this build can install, not
information about anyone's servers. `get_blueprint("minecraft-java")` additionally returns
`minecraftServerTypes` — the full matrix of values the `TYPE` variable accepts, each saying whether
it takes mods, plugins or both and whether it speaks RCON and the query protocol. Paper takes
Bukkit plugins and not Fabric mods; the matrix is how an agent avoids that mistake.

### Provisioning

| Tool                | Arguments                                                                                                                                     | Scope           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **`create_server`** | `name*`, `blueprintKey*`, `description`, `nodeId`, `limits`, `variables`, `ports`, `autoStart`=true, `autoRestart`=true, `startOnCreate`=true | `server.create` |
| **`delete_server`** | `serverId*`, `confirm`=false, `confirmServerName`                                                                                             | `server.delete` |

`create_server` goes through the same service the web UI uses — same validation, same node
placement, same port allocation. There is no agent-only shortcut and no way to exceed a limit a
human could not. `limits` takes `memoryMb`, `diskMb`, `cpuCores` (0 = unlimited), `swapMb` and
`ioWeight`; omit it and the blueprint's recommendation applies, which is usually right. Unknown
`variables` keys are dropped; invalid values are refused with a per-field message.

It **does not wait for the install**. With `startOnCreate` (the default) the call returns as soon
as the record exists, with `status: "provisioning"`; a first install downloads a multi-gigabyte
image. Poll `get_server_status`.

`delete_server` **does not back up first**, and cannot be undone. It needs _two_ confirmations in
the same call: `confirm: true` and `confirmServerName` matching the server's current name exactly.
Without both it deletes nothing and returns what would have been destroyed:

```
Nothing was deleted. Deleting "survival" destroys its container and its entire data directory,
including worlds and saves, and cannot be undone. To proceed, call delete_server again with
confirm: true and confirmServerName: "survival".
```

### Operations

| Tool                       | Arguments                                                                                | Scope                                          |
| -------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **`power_server`**         | `serverId*`, `action*` (`start`/`stop`/`restart`/`kill`), `force`=false, `confirm`=false | `power.start` / `power.stop` / `power.restart` |
| **`send_console_command`** | `serverId*`, `command*`                                                                  | `console.write`                                |
| **`get_server_status`**    | `serverId*`                                                                              | `server.view`                                  |

`power_server` maps each action to the permission a human needs for the same button; `kill` is
governed by `power.stop`, because a kill is a stop that skips the graceful path, not a fourth kind
of authority. `stop`, `restart` and `kill` disconnect every player and require `confirm: true`.
`force: true` skips the blueprint's graceful stop command and signals the process directly, which
risks world corruption on games that save on exit.

Only transitions the lifecycle allows are accepted, and a refusal names what is legal now:

```
invalid_state: survival is installing, so it cannot be started. Allowed right now: kill.
```

`stop` and `restart` block until the process has actually exited. `start` returns once the
container is up — **before the game has finished booting**. Poll `get_server_status` for that.

`send_console_command` sends exactly one command. It **cannot contain a newline**: container stdin
is line-oriented, so a second line would be a second command that nothing authorised and nothing
audited. Where the game speaks RCON and Platter can reach it, the command goes over RCON and the
game's reply comes back in `output` with `delivery: "rcon"`; otherwise it is written to stdin,
which is fire-and-forget — `output` is `null`, `delivery` is `"stdin"`, and the result only shows
up in the log. It **does not** validate player names; prefer the dedicated player tools.

`get_server_status` is cheap enough to poll. `playersOnline` is `null` when the count could not be
read — the server is off, or the game has no way to report it. **Null is not zero.**

### Debugging

| Tool                 | Arguments                                                                                                        | Scope          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------- |
| **`get_logs`**       | `serverId*`, `lines`=200 (max 500), `stream`=`all`, `filter`, `caseSensitive`=false                              | `console.read` |
| **`search_logs`**    | `serverId*`, `pattern*`, `window`=500, `maxMatches`=20 (max 50), `contextLines`=0 (max 3), `caseSensitive`=false | `console.read` |
| **`get_metrics`**    | `serverId*`, `metric*`, `range`=`1h`, `resolution`                                                               | `server.view`  |
| **`diagnose_crash`** | `serverId*`, `lines`=120                                                                                         | `console.read` |

`get_logs` returns the tail, oldest line first, hard-capped at 500 lines _and_ 64 KB — whichever
bites first wins, and the response says which via `capped` and a `note`. Individual lines are
truncated at 2000 characters so one runaway line cannot swallow the budget. `filter` is a
JavaScript regular expression applied _after_ reading, so it narrows the 500-line window rather
than searching further back.

`search_logs` searches that same window and returns matches with their position and optional
surrounding lines. `matched` is the true count even when the returned list was truncated. It
**does not search an archive** — Platter keeps no log history beyond what the container runtime
still holds.

Both compile a caller-supplied pattern under a 250 ms budget and report `filterGaveUp` /
`searchGaveUp` rather than hanging.

`get_metrics` covers `cpu`, `memory`, `disk`, `networkRx`, `networkTx`, `players`, `tps`. The
network metrics are cumulative counters, so differences between points are throughput. At most 240
points come back — the most recent ones — but `summary` is computed over the _whole_ requested
window, so a truncated series still gives correct min/max/average. Older ranges are served from
coarser rollups and `resolution` says which. An empty `points` array means no data yet, not a
failure: `players` and `tps` are empty for games that expose no way to read them.

`diagnose_crash` assembles evidence in one call: recorded exit code and crash time, the container
runtime's own view (exists, OOM-killed, when it finished), disk and memory against configured
limits, blueprint crash patterns that matched, and the log tail. `observations` are mechanical
readings, each carrying the line or number it came from — `eula_not_accepted`, `port_in_use`,
`jvm_out_of_memory`, `unsupported_java_version`, `corrupt_world`, `exception_thrown`. They are
evidence, not a verdict. **It changes nothing**: no restart, no repair.

### Mods

| Tool                      | Arguments                                                                                  | Scope         |
| ------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| **`search_mods`**         | `serverId*`, `query`, `category`, `gameVersion`, `source`, `limit`=10 (max 25), `offset`=0 | `server.view` |
| **`get_mod`**             | `serverId*`, `source*`, `project*`                                                         | `server.view` |
| **`list_installed_mods`** | `serverId*`                                                                                | `server.view` |
| **`check_mod_updates`**   | `serverId*`                                                                                | `server.view` |
| **`propose_mod`**         | `serverId*`, `source*`, `project*`, `rationale*`, `version`                                | `ai.use`      |
| **`get_proposal_status`** | `serverId*`, `proposalId`, `status`                                                        | `server.view` |

**None of these installs anything. None of them can.**

`search_mods` is pre-filtered to the server's loader and game version and to projects that run
server-side, so a client-only shader will not appear. `gameVersion: "any"` drops the version
filter for a wider look. `sources` reports each provider separately, so one that is down or
unconfigured shows as an error rather than quietly shrinking the results. Only blueprints with the
`mods` feature are supported — today, `minecraft-java`.

`get_mod` is the detail a human needs to judge a suggestion: full description, author, licence,
gallery, source and issue links, download count, and the versions this server could actually run.
When nothing is compatible, `incompatibleReason` names the constraint that failed rather than
returning an empty list. Read it before proposing and quote the parts that justify the
recommendation.

`list_installed_mods` tracks only what Platter installed — files dropped into `mods/` by hand are
not in the manifest and will not appear. `check_mod_updates` makes one upstream request per
installed mod, so do not poll it; `prerelease: true` marks an update whose only newer build is a
beta.

`propose_mod` is covered in full [below](#the-proposal-flow-end-to-end). `rationale` is the most
important argument: it is the first thing the reviewer reads.

`get_proposal_status` is read-only. An agent can watch the queue and cannot act on it.

### Players

| Tool                   | Arguments                                         | Scope           |
| ---------------------- | ------------------------------------------------- | --------------- |
| **`list_players`**     | `serverId*`                                       | `server.view`   |
| **`kick_player`**      | `serverId*`, `player*`, `reason`                  | `console.write` |
| **`ban_player`**       | `serverId*`, `player*`, `reason`, `confirm`=false | `console.write` |
| **`whitelist_player`** | `serverId*`, `player*`, `action`=`add`            | `console.write` |

`list_players` returns who is on now and everyone the server has ever seen, with playtime, session
count and op/whitelist/ban flags. History comes back even when the server is off. `source` says
where the live list came from: `rcon` and `query` are the running server, `logs` means nothing live
could be reached and the online set is inferred from join/leave lines.

`kick_player` is a nudge, not a ban — they can rejoin immediately. `ban_player` persists in the
game's own ban list, survives restarts, and needs `confirm: true`; lifting it is a manual step.

`whitelist_player` only changes the list. Whether the whitelist is _enforced_ is a separate server
setting, so the tool reads the roster back afterwards and tells you:

> The whitelist is not currently enforced on this server, so this change has no effect until it is
> turned on.

Removing an entry does not disconnect a player who is already on. All three require a running
server with RCON reachable, and all three are audited with the calling agent's identity.

### Network

| Tool                     | Arguments                                | Scope         |
| ------------------------ | ---------------------------------------- | ------------- |
| **`get_server_address`** | `serverId*`                              | `server.view` |
| **`check_reachability`** | `serverId*`, `timeoutMs`=2000 (200–5000) | `server.view` |

`get_server_address` returns the address to give a player plus every other allocated port.
Addresses are built from the node's configured public host, so they are only correct from wherever
that host is reachable.

`check_reachability` probes from the **Platter host**, and says so in its own summary:

> 3 of 3 allocated ports answered from the Platter host. This does not prove the server is
> reachable from the internet.

TCP ports get a connect test. UDP ports cannot be probed that way and come back
`reachable: null`, except a Minecraft query port, which is asked for a real status. **`null` means
"not testable", never "down".**

---

## Resources

Read-only context a client can attach to a conversation instead of spending a tool call.

| URI                                   | What it is                                                  |
| ------------------------------------- | ----------------------------------------------------------- |
| `platter://servers`                   | Every server this key can see, capped at the 25 most recent |
| `platter://blueprints`                | The catalogue plus the full Minecraft server-type matrix    |
| `platter://servers/{serverId}/config` | One server's stored configuration; passwords redacted       |
| `platter://servers/{serverId}/logs`   | The last 200 console lines as plain text                    |

Everything here is a projection of what the equivalent tool returns, under the same authorisation
— a resource is not a back door around `server.view`. The listing enumerates config and log
resources per visible server; a key without `server.view` simply sees the two static ones. Nothing
here mutates, and nothing exposes a secret: config goes through the same redaction `get_server`
uses.

Resources have no `isError` channel, so a refusal arrives as a JSON-RPC error. An unknown URI is
`-32002`, distinct from "that resource is empty".

---

## The proposal flow, end to end

This is the property the whole agent story rests on. Every response below is real output from a
live instance.

### 1. The agent proposes

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "propose_mod",
    "arguments": {
      "serverId": "srv_01KZHGD6DGE7W5B653JFD6A6TB",
      "source": "modrinth",
      "project": "lithium",
      "rationale": "Server-side tick optimisation. Four players in the nether drops this server to 12 TPS; lithium is the standard fix and changes no gameplay."
    }
  }
}
```

```json
{
  "proposalId": "mpr_01KZHGQZMC151HB0ZWH4HGWBER",
  "status": "pending",
  "serverId": "srv_01KZHGD6DGE7W5B653JFD6A6TB",
  "mod": { "source": "modrinth", "projectId": "gvQqBUqZ", "slug": "lithium", "title": "Lithium" },
  "versionId": "N08Z8wog",
  "versionNumber": "mc1.21.1-0.15.4-fabric",
  "installable": true,
  "dependencies": [],
  "problems": [],
  "installed": false,
  "nextStep": "Nothing was installed. Tell the human this is waiting in the Platter web UI under the server's Mods tab, and what they should look at before approving."
}
```

`installed` is pinned to the literal `false` by the output schema, so the answer to "did this
install anything" is fixed by the contract rather than by a line of handler code.

What actually happened: Platter resolved the mod and its dependencies against this server's loader
and game version, snapshotted exactly what the reviewer will be shown, and stored it. Nothing was
downloaded. Nothing on the server changed.

Omit `version` and Platter picks the newest compatible build. A proposal is still recorded when
the plan is _blocked_ — "this needs Fabric and you run Paper" is exactly what a reviewer should
see, and it comes back as `installable: false` with a `problems` array.

One pending proposal per project at a time:

```
conflict: Lithium already has a proposal waiting for review. Review that one first.
```

### 2. The agent reports and waits

```json
{
  "name": "get_proposal_status",
  "arguments": { "serverId": "srv_01KZ…", "proposalId": "mpr_01KZ…" }
}
```

```json
{
  "proposals": [
    {
      "proposalId": "mpr_01KZHGQZMC151HB0ZWH4HGWBER",
      "status": "pending",
      "title": "Lithium",
      "versionNumber": "mc1.21.1-0.15.4-fabric",
      "rationale": "Server-side tick optimisation. Four players in the nether drops this server to 12 TPS…",
      "proposedByName": "docs-check (Owner via key plt_kN4XJjS7)",
      "proposedAt": "2026-08-08T20:24:01.932Z",
      "reviewedByName": null,
      "reviewedAt": null,
      "reviewNote": null,
      "driftDetectedAt": null,
      "installedVersionId": null,
      "error": null
    }
  ],
  "total": 1,
  "truncated": false
}
```

Note `proposedByName`. All three identities are load-bearing when someone later asks who did this:
the MCP client that made the call, the human account it acted as, and the key that carried it —
which is the only one of the three you can revoke.

Statuses: `pending` (waiting for a human), `approved` (approved and the files were installed),
`rejected`, `failed` (approved but the install errored — see `error`).

### 3. A human reviews

In the web UI, under the server's Mods tab. The reviewer sees the snapshot: description, images,
author, licence, download count, dependencies, and the agent's rationale. **There is no MCP tool
for this step, by construction.**

Over HTTP the same actions are `POST /api/v1/servers/:serverId/proposals/:id/approve` and
`/reject`, both requiring `files.write` on the server — never `ai.use`.

```bash
curl -s -X POST "$BASE/api/v1/servers/$SRV/proposals/$PID/reject" \
  -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"note":"Not now — we are mid-season."}'
# → {"status":"rejected","reviewedByName":"Owner","reviewNote":"Not now — we are mid-season."}
```

### 4. Approval re-checks reality

Approving does not install the snapshot. It drops the provider cache, re-fetches the project and
version, re-resolves dependencies against the server _as it is now_, and diffs everything that
decides what code runs — checksums, download URL, filename, dependency set, loaders, game
versions, and every jar the plan would actually write.

Here is that gate firing. Between proposal and approval, the upstream file hash was changed:

```
POST /api/v1/servers/srv_…/proposals/mpr_…/approve     →  409 Conflict
```

```json
{
  "status": "changed",
  "changes": [
    {
      "field": "plan",
      "material": true,
      "before": "modrinth:gvQqBUqZ → mods/lithium-fabric-0.15.4+mc1.21.1.jar (N08Z8wog, 182064b00e63…)",
      "after": "modrinth:gvQqBUqZ → mods/lithium-fabric-0.15.4+mc1.21.1.jar (N08Z8wog, 000000000000…)"
    },
    { "field": "sha512", "material": true, "before": "182064b00e63…", "after": "000000000000…" },
    { "field": "sha1", "material": true, "before": "7d82a004403b…", "after": "111111111111…" }
  ],
  "digest": "62402b410f2068e0e5af86c9b86ad1fc20dd783e4d677dfacc88ad366dfa06ed"
}
```

Nothing was installed. `driftDetectedAt` is stamped on the proposal, and `get_proposal_status`
surfaces it to the agent. To proceed, the reviewer must pass the **new** digest back as
`acknowledgedDigest` — which is them stating, in the protocol, that they read what changed.

A project renaming itself or changing its icon deliberately does _not_ trip this, because a gate
that fires on cosmetics is one reviewers learn to click through.

### 5. Installation

Only after approval, and only through `services/mods.ts#applyResolution`: HTTPS from an allowlist
of that source's CDN hosts, hashed while streaming, checksum compared against the published digest
_before_ the file moves into place, then an atomic rename within the destination directory. An
unverified jar never exists at a path the game will scan. See
[SECURITY.md](SECURITY.md#the-mod-supply-chain).

---

## Safety properties, and why each one holds

Each of these is a mechanism, not a promise.

**1. No tool installs, updates or removes a file.**
`mcp/tools.ts` imports only the read-only half of the mod service, and only `propose` from the
proposal service. `applyResolution`, `approve`, `removeInstalledMod`, `installModFile`,
`removeModFile`, `recordInstalledMod` and `forgetInstalledMod` appear nowhere in the MCP module.
_Why it holds:_ a test parses the MCP source files, extracts every import specifier and binding —
including dynamic `import()` and `require()` — and fails the build if any of those symbols or the
`mods/install` module appears. It is checked, not remembered.

**2. Destructive tools do nothing without an explicit confirmation argument.**
`delete_server` needs `confirm: true` **and** `confirmServerName` matching exactly.
`power_server` needs `confirm: true` for stop, restart and kill. `ban_player` needs `confirm:
true`.
_Why it holds:_ the check is in the handler before any state changes, and the unconfirmed branch
returns a description of what would happen. An agent that has not been asked for that specific
thing has no way to stumble into it.

**3. Authorisation is applied twice, and cannot be bypassed by the agent surface.**
Every call is checked against the API key's scopes and then against the same per-server permission
the equivalent HTTP route enforces.
_Why it holds:_ both surfaces parse scopes through the same `lib/scopes.ts` and resolve
per-server access through the same rules. A scope system only one surface consults is not a scope
system.

**4. A server you cannot see is indistinguishable from one that does not exist.**
`notFound`, never `forbidden`, for a server the principal has no relationship to — and a malformed
id returns the same answer.
_Why it holds:_ it is the rule `requireServerAccess` follows on the HTTP side, and `authorizeServer`
in `mcp/auth.ts` follows it deliberately so the two cannot disagree.

**5. A session's authority is fixed when it is created.**
No tool takes an "act as" argument. A different key presented against an existing HTTP session is
refused.
_Why it holds:_ the server instance is constructed bound to one resolved principal, before any
client message is processed. Nothing the client sends afterwards can change it.

**6. A browser session token cannot drive the agent surface.**
MCP accepts API keys only.
_Why it holds:_ the credential resolver is separate from the HTTP one and only ever looks up
`plt_`-prefixed keys. A bearer value that is not one is treated as _no_ credentials.

**7. Every write is attributable to a revocable credential.**
Audit rows carry `via: "mcp"`, the tool name, the API key id and prefix, plus the client name, the
account, and the source address.
_Why it holds:_ the audit helper used by every writing tool builds that metadata itself from the
session's principal; a handler cannot attribute an action to anyone else.

**8. Nothing an agent can call is unbounded.**
Every list has a ceiling, every response says when it hit one, log payloads are capped by both
line count and bytes, caller-supplied regexes run under a time budget, and there are at most 32
concurrent sessions.
_Why it holds:_ an agent's context window is the scarce resource; a tool that returned half a
million log lines would be a denial of service against the client.

---

## Troubleshooting

**`Set PLATTER_API_KEY to a Platter API key.`** — stdio, no key in the environment. Note that
Claude Desktop does not inherit your shell; put it in the `env` block of the config.

**`That API key is not valid.`** — wrong key, or it was revoked. Prefixes are visible in Settings →
API keys; check the one you are sending matches a listed key.

**`That API key has expired.`** — mint a new one. The distinct error code exists so a client can
tell "rotate me" from "you are wrong".

**`This API key is not scoped for X.`** — the key was minted without scope `X`. Scopes cannot be
edited; mint a new key. See [Choosing scopes](#choosing-scopes).

**`Missing Mcp-Session-Id.`** — you sent a non-initialize request without a session. Initialize
first and use the id from the response header.

**`That MCP session is not open.`** — the session was swept (30 minutes idle), the process
restarted, or you have the wrong id. Reinitialise.

**`That MCP session belongs to a different API key.`** — you are reusing a session id with another
key. Open your own.

**`Platter is already serving 32 MCP sessions.`** — close idle clients, or wait. Retryable.

**The client connects but hangs on every call (HTTP only)** — a proxy is buffering the SSE
response. See [DEPLOYMENT.md](DEPLOYMENT.md#reverse-proxy-and-tls).

**The client reports a JSON parse error (stdio only)** — something wrote to stdout that was not a
protocol frame. Platter's own diagnostics all go to stderr; if you wrapped the command in a shell
script, make sure it prints nothing.

**Tools that hit Modrinth or CurseForge fail** — `service_unavailable: Modrinth could not be
reached.` means no egress or a blocked host; `not_found` means the project reference was wrong.
CurseForge needs `CURSEFORGE_API_KEY`; Modrinth needs no key. `MODRINTH_BASE_URL` points the client
at a mirror.
