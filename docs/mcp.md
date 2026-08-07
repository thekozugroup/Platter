# The MCP server

Platter exposes its servers to AI assistants through the Model Context Protocol. An assistant can
read anything; changing a server always waits for you.

## Connecting

**Claude Code:**

```bash
claude mcp add platter -- npx -y @platter/mcp
```

**Claude Desktop, Cursor, Windsurf** — add to your MCP config:

```json
{
  "mcpServers": {
    "platter": {
      "command": "npx",
      "args": ["-y", "@platter/mcp"]
    }
  }
}
```

**Over HTTP**, for clients that connect to a running server rather than spawning one:

```bash
pnpm mcp -- --http
```

It prints the URL and a bearer token on first run and stores the token in
`$PLATTER_DATA_DIR/mcp-token` (mode 0600), so your client config keeps working across restarts.
HTTP mode is always authenticated, and refuses to bind beyond loopback without
`PLATTER_MCP_TOKEN` set explicitly.

## Tools

### Reading — no confirmation

| Tool | What it does |
| --- | --- |
| `list_servers` | Every server, with status, version, address and limits. |
| `get_server` | One server in full, plus live CPU/memory when running. |
| `get_server_logs` | Tail the console, optionally filtered. |
| `get_players` | Who is connected right now. |
| `get_activity` | The event log, including AI proposals and human decisions. |
| `list_installed_mods` | What is installed, and what was pulled in as a dependency. |
| `list_backups` | Backups with size and whether each was taken live. |
| `search_mods` | Search Modrinth and CurseForge. |
| `check_mod` | **The authoritative compatibility answer** for a specific server. |
| `diagnose_server` | Read the logs and explain what is wrong, with fixes. |

### Changing — always confirmed

| Tool | What it does |
| --- | --- |
| `control_server` | Start, stop or restart. Tells you who is online first. |
| `run_command` | Any console command. Read-only verbs run without asking. |
| `install_mods` | Install with dependencies, after a compatibility check. |
| `remove_mods` | Remove, warning about anything that depends on them. |
| `create_backup` | Take a backup. Not confirmed — it only ever adds a file. |
| `restore_backup` | Roll back. Confirmed, and takes a safety copy first. |
| `apply_fix` | Carry out a fix `diagnose_server` suggested. |

## How confirmation works

When a tool needs a decision, your client shows a prompt built from the proposal:

```
Install Lithium 0.14.3 and Ferritecore 7.0.2 on Survival?

• Lithium 0.14.3
• FerriteCore 7.0.2

Plus these required dependencies:
• Fabric API 0.115.0

Total download: 2.4 MB.
Files go in /data/mods.
Platter backs the server up first, and the server needs a restart to load them.
```

Behind that prompt:

1. A **proposal row** is written before you are asked, carrying the model's reasoning and the
   compatibility report that justified it.
2. Your answer is recorded against it. Declining and dismissing are treated identically — Platter
   never retries a dismissed prompt as though it were an unanswered one.
3. If you approve, the action runs and the outcome is written back to the same row.

You can read the whole history in the Activity tab, or through `get_activity`. Every AI-initiated
change is tagged and linked to the decision that permitted it.

There is no auto-approve flag. If your client does not support elicitation prompts, destructive
tools refuse and point you at the UI rather than proceeding.

## A worked example

> **You:** My Fabric server keeps crashing. Sort it out.

The assistant calls `list_servers`, then `diagnose_server`:

```
Server crashed on startup: a mod is missing a dependency.

✗ Missing required dependency
   Sodium 0.6.0 requires Fabric API 0.100.0 or newer, which is not installed.
   → Install Fabric API (Platter can do this)
     Downloads the newest Fabric API compatible with 1.21.4 and restarts the server.
```

It calls `apply_fix`. You get a prompt, you approve, Platter backs up, installs, restarts. The
assistant calls `diagnose_server` again to confirm, and tells you it is fixed.

What it did **not** do: guess at the version, install anything before you said yes, or tell you it
was fixed without checking.

## Writing prompts that work well

- Name the server, or let the assistant call `list_servers` first. It accepts ids, slugs and
  display names.
- For anything mod-related, insist on `check_mod` before `install_mods`. Search results describe
  a project's *historical* support, not one downloadable file, and that gap is where every
  "compatible" mod that isn't comes from.
- After a crash, `diagnose_server` before anything else. Guessing from a raw log tail wastes turns
  on problems the rule catalogue already recognises.

## Security

The stdio transport inherits the trust of whatever spawned it — usually your editor, running as
you. The HTTP transport is authenticated with a timing-safe bearer check and binds to loopback by
default.

The MCP server can do anything the UI can, which includes deleting servers and their worlds. That
is why every destructive path is gated on a human decision, and why there is no way to turn that
off. See [SECURITY.md](../SECURITY.md).
