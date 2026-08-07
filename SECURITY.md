# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[private vulnerability reporting](https://github.com/thekozugroup/Platter/security/advisories/new)
rather than opening a public issue. We aim to acknowledge within 72 hours.

## Threat model

Platter is **local-first**. The default posture assumes:

- Platter runs on a machine you control, on your LAN or localhost.
- The web UI binds to `127.0.0.1` unless you explicitly change `PLATTER_HOST`.
- The person using the UI is the machine's administrator.

This is a deliberate trade-off: it removes the multi-tenant complexity of a hosted panel. If you
expose Platter to the internet, you take on the responsibilities below.

## What Platter can do to your machine

Platter talks to the Docker daemon. **Access to the Docker socket is equivalent to root on the
host.** This is inherent to any Docker-driven control panel (PufferPanel, Pterodactyl, Portainer
all share it). Platter reduces the blast radius rather than pretending it isn't there:

- **Scoped operations.** Platter only ever inspects, creates, starts, stops, and removes
  containers carrying the `platter.managed=true` label, and only ever removes volumes under its
  own data root. Every Docker call goes through `packages/core/src/docker/guard.ts`, which
  refuses to act on unlabelled resources.
- **No arbitrary image execution.** Server images come from a curated manifest set. A custom
  image requires explicitly setting `PLATTER_ALLOW_CUSTOM_IMAGES=1`.
- **No privileged containers.** Game containers run with `Privileged: false`, all capabilities
  dropped except those the image needs, `no-new-privileges`, a read-only root filesystem where
  the image supports it, and a non-root user (uid/gid 1000).
- **Resource caps are mandatory.** Every container gets a memory limit, a pids limit, and a CPU
  quota. A runaway mod cannot take the host down.
- **Path containment.** The file manager and backup system resolve every path against the
  server's data root and reject anything that escapes it after symlink resolution.

## Authentication

- The UI is unauthenticated when bound to loopback, matching how local dev tools behave.
- Setting `PLATTER_HOST` to anything other than a loopback address **requires**
  `PLATTER_AUTH_TOKEN` to be set. Platter refuses to start otherwise. `PLATTER_HOST` is the
  address the socket is bound to, not a label — `apps/web/scripts/serve.mjs` passes it to Next
  as `-H`, and the container entrypoint maps it onto Next's own `HOSTNAME`.
- The MCP HTTP transport always requires a bearer token (`PLATTER_MCP_TOKEN`). The stdio
  transport inherits the trust of the process that spawned it.
- Tokens are compared with a constant-time equality check.
- Requests are rejected unless their `Host` header is an IP literal, a loopback name, or listed
  in `PLATTER_ALLOWED_HOSTS`, and state-changing requests are rejected if `Origin` names a
  different host. Loopback binding is not a boundary against a browser: a page you visit can
  point its own short-TTL domain at `127.0.0.1` and talk to Platter as same-origin, reading
  responses and carrying the session cookie with it. Set `PLATTER_ALLOWED_HOSTS` if you reach
  Platter by a DNS name or through a reverse proxy.

## Secrets

- RCON passwords are generated per server with `crypto.randomBytes(24)` and stored in the local
  SQLite database. They are redacted from logs, exports and diagnostic bundles.
- A server's RCON password **is** shown on its settings page, behind a reveal control. That mask
  is a screen-sharing courtesy, not a boundary: the value is in the page payload. Anyone who can
  reach the UI can read it, which is the same trust level as being able to drive the UI at all.
- The MCP bearer token is written to `$PLATTER_DATA_DIR/mcp-token` with mode `0600` and printed
  to the terminal only on the run that generates it. Later runs print the path instead, so the
  credential does not accumulate in `journalctl` or `docker logs`.
- Modrinth and CurseForge API keys live in the environment, are never persisted to the database,
  and are redacted from any bundle Platter generates.
- The diagnostic bundle generator runs every artefact through a redaction pass before writing.

## AI actions

The MCP server exposes destructive tools (install a mod, restart a server, roll back a backup).
These are gated:

- Every destructive tool is annotated `destructiveHint: true`.
- Mod installation and rollbacks go through an **elicitation** step: the model proposes, the
  human confirms or rejects in their client. There is no "auto-yes" flag.
- Every AI-initiated action is written to the audit log with the proposal that produced it.

## Supported versions

Security fixes land on `main` and the latest minor release.
