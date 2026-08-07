# Contributing to Platter

Thanks for helping out. Platter is an open source, local-first game server platform — the bar
is "someone can clone this, run one command, and be playing Minecraft with their friends in
five minutes." Every change should keep that true.

## Getting set up

```bash
git clone https://github.com/thekozugroup/Platter.git
cd Platter
pnpm install
pnpm db:migrate
pnpm dev
```

Requirements:

- Node.js >= 22.12
- pnpm 10
- Docker Engine 24+ with the daemon running and the socket readable by your user

## Repo layout

| Path                  | Purpose                                                 |
| --------------------- | ------------------------------------------------------- |
| `apps/web`            | Next.js app — the UI and its HTTP API                   |
| `apps/mcp`            | The Model Context Protocol server (stdio + HTTP)        |
| `packages/core`       | Docker orchestration, server lifecycle, RCON, backups   |
| `packages/db`         | Drizzle schema, migrations, SQLite client               |
| `packages/mods`       | Modrinth + CurseForge clients and the compat engine     |
| `packages/diagnostics`| Log parsing and the diagnosis rule catalog              |
| `packages/shared`     | Zod schemas, shared types, constants                    |
| `docker/`             | Dockerfile + compose for running Platter itself         |

Dependencies flow one way: `shared` → `db` → `mods`/`diagnostics` → `core` → `web`/`mcp`.
Nothing in `packages/` may import from `apps/`.

## Before you open a PR

```bash
pnpm check   # lint + typecheck + unit tests
```

Integration tests need a working Docker daemon and pull real images:

```bash
PLATTER_INTEGRATION=1 pnpm test:integration
```

## Conventions

- **TypeScript everywhere**, `strict` on. No `any` without a comment explaining why.
- **Zod v4** for every external boundary — API responses, env vars, request bodies. Parse, don't
  cast. Third-party APIs (Modrinth, CurseForge) change; the schemas are how we find out.
- **Biome** for lint + format. `pnpm lint:fix` before committing.
- **Result types over exceptions** in `packages/core` for expected failures (a container that
  won't start is not exceptional). Throw for programmer error.
- **No network in unit tests.** Use the fixture-backed fakes in `packages/mods/src/testing`.
- Keep server-only code out of client components. `packages/core` imports `dockerode`; it must
  never end up in a browser bundle.

## Adding a game

Games are declared as manifests in `packages/core/src/games/`. A manifest describes the image,
the env var mapping, port layout, health check, and log patterns. Adding a game should not
require touching the orchestrator. If it does, that is a bug in the orchestrator — please say so
in your PR.

## Adding a diagnosis rule

Rules live in `packages/diagnostics/src/rules/`. Each rule needs:

1. A stable `id`
2. A matcher (regex or predicate over parsed log lines)
3. A human explanation
4. At least one suggested fix, ideally a machine-applicable one
5. A test with a real log excerpt in `packages/diagnostics/src/rules/__fixtures__/`

Real log excerpts only. Invented ones drift from reality and the rule stops firing.

## Commit messages

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). The scope is the
package: `feat(core): add autopause support`.

## Security

Please do not open public issues for security problems. See [SECURITY.md](./SECURITY.md).
