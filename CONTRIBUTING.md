# Contributing to Platter

Issues and pull requests are welcome. This file covers getting a working checkout, the one thing
that makes development pleasant (the mock driver), what `pnpm verify` must say before you open a
PR, and how to add a game — which is the most likely contribution and is **data, not code**.

- [Setup](#setup)
- [The mock driver](#the-mock-driver)
- [Running the app](#running-the-app)
- [`pnpm verify`](#pnpm-verify)
- [Adding a game blueprint](#adding-a-game-blueprint)
- [Commits and pull requests](#commits-and-pull-requests)
- [Where the contracts live](#where-the-contracts-live)

---

## Setup

You need **Node ≥ 22** and **pnpm ≥ 10**. The repository pins `pnpm@10.33.0` via `packageManager`,
so `corepack enable` gets you the right one.

You do **not** need Docker to develop, and you do not need it to run the tests.

```bash
git clone https://github.com/thekozugroup/Platter.git
cd Platter

pnpm install
pnpm --filter @platter/shared build            # the API and web compile against its dist
pnpm --filter @platter/api exec prisma generate
pnpm --filter @platter/api exec prisma migrate deploy
```

Order matters. `@platter/shared` is consumed through its built `dist`, so a fresh checkout that
skips that build produces a wall of module-resolution errors that look like a broken install. The
Prisma client is generated code — nothing typechecks until it exists.

A minimal `.env` at the repository root:

```bash
JWT_SECRET=a-development-secret-of-at-least-32-characters
DATABASE_URL=file:./data/platter.db
DEFAULT_NODE_DRIVER=mock
PUBLIC_HOST=127.0.0.1
LOG_LEVEL=warn
```

`JWT_SECRET` is technically optional in development — a random one is generated per process, with
a warning, and every restart signs you out. Setting it saves you re-logging-in after every edit.

Create the first account through the UI: a fresh install reports `needsSetup` and serves first-run
setup, and the first account created is always the `owner`. Or use the seed script, which also
creates the local node:

```bash
SEED_EMAIL=you@example.com pnpm --filter @platter/api db:seed
```

It is idempotent — it never overwrites an existing owner and never resets a password — and it
prints a generated password exactly once if you did not supply `SEED_PASSWORD`.

### The repository

```
packages/shared     Domain vocabulary, the lifecycle state machine, error codes, and the zod
                    schemas for every request and response. Imported by BOTH sides, so the wire
                    format has one source of truth and a contract change is a type error.
apps/api            Fastify server: auth, routes, console WebSocket, orchestration, scheduler,
                    mods, MCP.
  src/orchestration   OrchestrationDriver interface; Docker and Mock implementations.
  src/services        Lifecycle, allocations, files, backups, scheduler, players, mods.
  src/blueprints      The game catalogue. Start here.
  src/mcp             The MCP server.
  src/routes          The HTTP surface.
apps/web            React 19 SPA — Shark UI components on the Ghost design system.
docs/               Architecture, design contract, deployment, security, MCP.
```

Dependencies flow one way: `packages/shared` knows nothing about either app.

---

## The mock driver

`DEFAULT_NODE_DRIVER=mock` swaps the Docker orchestration driver for a complete in-memory
stand-in. It implements the same `OrchestrationDriver` interface — creating, starting, stopping,
inspecting, streaming logs, reporting usage — with simulated pulls and boots.

This is the single thing that makes this codebase pleasant to work on. With it you can:

- run the entire test suite with **no Docker daemon and no network**;
- click through the whole UI, create servers, watch them "boot", read a live console;
- work on a laptop, in a container, or in CI, identically.

The whole test suite and every CI job run this way. If you find yourself needing a real daemon to
test a change, that is worth mentioning in the PR — it usually means the change reaches past the
driver interface, which is a design question rather than a coding one.

Set it in `.env`, or per command:

```bash
DEFAULT_NODE_DRIVER=mock pnpm test
```

Note that the driver is recorded on the _node row_ when the node is first created. A database
seeded with `mock` keeps mock nodes even if you later change the environment variable; delete the
SQLite file, or edit the node, to switch.

---

## Running the app

```bash
pnpm dev        # API on :8080, web on :5173, in parallel
```

The Vite dev server proxies API and WebSocket traffic to the API process, so develop against
<http://localhost:5173> and everything — REST, console socket, MCP — works from one origin.

Useful targets:

```bash
pnpm --filter @platter/api dev        # API only, tsx watch
pnpm --filter @platter/web dev        # client only
pnpm --filter @platter/api test       # 452 API tests
pnpm --filter @platter/web test       # 151 client tests
pnpm --filter @platter/shared test    # 23 contract tests
pnpm --filter @platter/api exec vitest run src/blueprints   # one directory
pnpm test:e2e                         # Playwright, needs a browser installed
```

The OpenAPI browser is at <http://localhost:8080/docs>, generated from the same zod schemas the
routes validate with — there is no second, hand-written description of the API to drift out of
date.

---

## `pnpm verify`

```bash
pnpm verify        # typecheck && lint && test
```

**This must pass before you open a pull request.** CI runs the same three plus `pnpm format:check`
and the Playwright suite.

| Command             | What it enforces                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | `tsc --noEmit` across all three packages. The API is ESM/NodeNext, so **relative imports need a `.js` extension** even though the source is `.ts`. This is the single most common first-PR failure. |
| `pnpm lint`         | `eslint . --max-warnings=0`. A warning is a failure.                                                                                                                                                |
| `pnpm test`         | Vitest in all three packages.                                                                                                                                                                       |
| `pnpm format:check` | Prettier: single quotes, semicolons, trailing commas, 100 columns. `pnpm format` fixes it.                                                                                                          |

If `verify` fails on a fresh checkout rather than on your change, you probably skipped
`pnpm --filter @platter/shared build` or `prisma generate` — see [Setup](#setup).

### About the tests

They are real. The API suite runs against a real SQLite database and a real (mock-backed)
orchestration driver, driving Fastify through `app.inject`. Each test file gets its own database,
seeded from a template built once in a global setup step. Files run one at a time
(`fileParallelism: false`) because they share process-wide singletons — the driver registry, the
log hubs, the mDNS advertisement map — and running them concurrently turns those into
order-dependent flakes that cost more to chase than the wall clock saves.

A new feature is expected to come with tests. A bug fix is expected to come with the test that
fails without it.

---

## Adding a game blueprint

**This is the contribution most likely to be wanted, and it is data.** A blueprint is a
declarative recipe for one game: which community image to run, what an operator may configure, how
to tell from the log that it finished booting, and how to shut it down without losing the world.
Nothing in a blueprint executes anything or knows what a container is.

Twelve ship today. Adding a thirteenth is one file plus one line.

### 1. Write the file

Create `apps/api/src/blueprints/<key>.ts`. Read
[`terraria.ts`](apps/api/src/blueprints/terraria.ts) first — it is the shortest complete example,
and it covers the interesting case of a game configured by file rather than by environment.

```ts
import type { BlueprintDefinition } from './index.js';

export const myGameBlueprint: BlueprintDefinition = {
  key: 'my-game', // lowercase slug, stable forever — servers join on it
  name: 'My Game',
  game: 'My Game',
  summary: 'One line for the picker.',
  description: 'A paragraph or two. Say what an operator will get wrong.',
  // survival | sandbox | shooter | simulation | strategy | roleplay | other
  category: 'survival',
  image: 'somebody/my-game:1.4.2', // MUST be pinned — see the checklist
  icon: { monogram: 'MG', hue: 210 }, // no image assets needed

  minMemoryMb: 1024,
  recommendedMemoryMb: 4096,
  minDiskMb: 4096,

  ports: [
    { name: 'game', label: 'Game', containerPort: 7777, protocol: 'udp', primary: true },
    { name: 'rcon', label: 'RCON', containerPort: 27015, protocol: 'tcp', bindLocal: true },
  ],

  variables: [
    {
      key: 'MAX_PLAYERS', // SCREAMING_SNAKE_CASE
      label: 'Player slots',
      description: 'Shown under the field. Say what it actually does.',
      type: 'number', // string | number | boolean | enum | password
      default: 8,
      min: 1,
      max: 64,
    },
    {
      key: 'SERVER_PASSWORD',
      label: 'Server password',
      description: 'Leave empty for an open server.',
      type: 'password', // redacted in every API response
      default: '',
      max: 64,
    },
  ],

  // Optional: rendered into the data volume, with {{VAR}} substitution.
  files: [],

  signals: {
    ready: ['Server started'], // regex sources, matched against stdout
    crash: ['Fatal error', 'Segmentation fault'],
    playerJoin: ['^(.+) joined the game'], // group 1 is the player name
    playerLeave: ['^(.+) left the game'],
  },

  stop: {
    strategy: 'command', // 'command' (preferred) or 'signal'
    command: 'quit',
    signal: 'SIGTERM',
    timeoutSeconds: 60,
  },

  // Optional: hold the game still while a backup is taken. Omit when the game has no
  // such command — it is then archived live, which is what everything did before this.
  saveCommands: null,

  dataPath: '/home/steam/game', // where the volume is mounted inside the container
  features: { console: true, rcon: true, mods: false, worldUpload: true, playerList: true },
  docsUrl: 'https://github.com/somebody/my-game-docker',
};
```

Definitions are written as `z.input`, not as the fully-populated `Blueprint`, so you only spell
out the fields you care about — `advanced`, `hidden`, `protocol`, `required` and the rest come from
the schema's defaults.

That example is not decorative: it parses against the frozen `blueprintSchema` as written, and
satisfies every invariant in the next section.

### 2. Register it

In [`apps/api/src/blueprints/index.ts`](apps/api/src/blueprints/index.ts), import it and add it to
`BLUEPRINT_DEFINITIONS`. **Order is the order the picker shows**, so Minecraft leads and new
entries usually go near the end.

```ts
import { myGameBlueprint } from './my-game.js'; // note the .js — ESM/NodeNext

export const BLUEPRINT_DEFINITIONS: readonly BlueprintDefinition[] = [
  minecraftJavaBlueprint,
  // …
  myGameBlueprint,
];
```

That is the whole registration. `services/blueprints.ts` parses every definition against the frozen
`blueprintSchema` at module load, so a malformed entry stops the process at startup rather than
surfacing weeks later as a server that will not boot.

### 3. Run the tests

```bash
pnpm --filter @platter/api exec vitest run src/blueprints
```

```
 Test Files  1 passed (1)
      Tests  124 passed (124)
```

The suite runs a set of invariants against **every** blueprint in the catalogue, so a new one
inherits them automatically. Each of these is a real failure mode someone has hit:

| Invariant                                                                                      | Why                                                                         |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Parses against the frozen `blueprintSchema`                                                    | Everything else assumes it did                                              |
| Exactly one `primary: true` port, and unique port names                                        | "The address" has to be unambiguous                                         |
| `recommendedMemoryMb >= minMemoryMb`                                                           | The picker shows both                                                       |
| Every `signals` pattern compiles, and `ready` is non-empty                                     | Without a ready pattern a server never leaves `starting`                    |
| Every variable `pattern` compiles                                                              | A bad regex breaks validation for every operator                            |
| The image is pinned — no `:latest`, `:stable`, `:dev`, `:main`, `:master`, `:edge`, `:nightly` | A moving tag means an operator's server silently changes version under them |
| `strategy: 'command'` implies a non-empty `command` **and** `features.console: true`           | A stop command is undeliverable without a console                           |
| `strategy: 'signal'` implies `command: null` and a `SIG…` signal name                          | Same, from the other side                                                   |
| `stop.timeoutSeconds > 0`                                                                      | Zero means SIGKILL immediately, which loses the world                       |

### Getting a blueprint right

The schema will not catch these; a reviewer will.

- **Use an image the community already runs and trusts**, pinned to a tag or digest. Platter runs
  the same containers you would run by hand — it does not fork, patch or reimplement any part of a
  game server. See [the scope boundary](docs/ARCHITECTURE.md#1-scope-boundary--what-platter-is-not).
- **Prefer `strategy: 'command'`.** Most games only write the world on autosave or on a clean exit.
  A signal skips that. Terraria's `exit`, Minecraft's `stop` — use the game's own save-and-quit,
  and give it a `timeoutSeconds` long enough for a big world.
- **Mark admin ports `bindLocal: true`.** RCON is plaintext and a successful auth is arbitrary
  console execution; a port bound to `0.0.0.0` by default is an unauthenticated-until-password
  remote shell facing your whole network. Platter binds `bindLocal` ports to `127.0.0.1` on a local
  node.
- **`type: 'password'` for anything secret.** Those variables are redacted in every API response
  and listed by key in `redactedVariables`.
- **Write descriptions for a person who has not run this game before.** "Only used when the world
  is first generated" is the kind of sentence that stops a support thread before it starts.
- **`saveCommands` where the game has them.** Archiving a region directory mid-write produces a
  file that passes its own checksum and still restores a corrupt world. `flush` then `resume`, and
  `resume` runs even when the backup failed.
- **Be honest in `features`.** `rcon: false` for a game that does not speak it; `playerList: false`
  where there is no way to read one. Platter reports "unavailable" rather than inventing a number,
  and a lie here becomes a UI that shows zero players forever.

### When a blueprint is not enough

A few blueprints need environment that cannot be static data — a JVM heap size derived from the
container's memory limit, or an advertised address built from an allocated port. Those get an
**environment hook** in `ENVIRONMENT_HOOKS`, keyed by blueprint key. A hook receives the resolved
variables and the server's limits and allocations, and returns values merged _over_ them. Every
existing hook returns `{}` when the operator has already set the variable, which keeps "the
operator wins" true by construction. Add one only when static data genuinely cannot express it.

---

## Commits and pull requests

### Commits

Present tense, imperative, and say what changed and why. The "why" is the part that is expensive
to recover later.

```
Bind RCON ports to loopback on local nodes

RCON is plaintext and a successful auth is arbitrary console execution, so a
port published on 0.0.0.0 is an unauthenticated-until-password remote shell.
Remote nodes keep the wide bind, because Platter itself could not reach it
otherwise.
```

Conventional Commits are welcome but not required. What is required is that the message is about
the change, not about the process — `fix stuff`, `wip`, `address review` tell a future reader
nothing.

### Pull requests

Include:

1. **What changed and why.** If it fixes an issue, link it.
2. **How you know it works.** Paste the real output of `pnpm verify`, or of the specific test. A
   false green is worse than a known gap — if something is untested, say so.
3. **Screenshots for UI changes.** Light and dark, and both states of anything that has states.
4. **Anything you decided not to do**, and why. That is often the most useful part of the
   description.

Keep them focused. A blueprint addition, a bug fix and a refactor are three pull requests.

### Style

Prettier and ESLint decide formatting; do not argue with them, and do not reformat files you did
not otherwise touch.

Beyond that, one convention that matters here more than most: **comments explain why, not what.**
The existing codebase is dense with comments recording the reasoning behind a non-obvious choice —
why the rate limiter keys on `request.ip` and nothing else, why refresh reuse burns the whole
family, why the metrics database is a separate file. Match that. A comment restating the line
below it is noise; a comment recording the thing that will otherwise be rediscovered painfully in
six months is the most valuable thing in the diff.

### What will get pushed back

- **Anything that reimplements part of a game server.** A custom jar, a fork of Paper or Fabric, a
  patched runtime, anything that makes a Platter-managed server behave differently from the same
  image run by hand. This boundary is permanent and is written down in
  [ARCHITECTURE.md §1](docs/ARCHITECTURE.md#1-scope-boundary--what-platter-is-not).
- **An MCP tool that installs, updates or removes a file.** An agent proposes; a human approves.
  This is enforced by the dependency graph and by a test that parses the MCP source for banned
  imports — including dynamic ones. See [SECURITY.md](docs/SECURITY.md#the-mod-supply-chain).
- **A green tick that is not true.** A status the code cannot actually verify, a metric invented
  where the game does not report one, a reachability claim stronger than the evidence. Platter says
  "unavailable" and "reachable on your local network but not necessarily from the internet"
  precisely because those are the honest answers.
- **New dependencies without a reason.** Say what it does that the existing surface cannot.
- **Changes to `packages/shared` schemas without both sides updated.** That package exists so the
  wire format has one source of truth; a change that only compiles on one side has broken the
  contract, not moved it.

---

## Where the contracts live

Four documents, and they are all load-bearing.

| Document                                       | What it decides                                                                                                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | What Platter is and — §1 — what it will never be. Also why TypeScript, how the packages depend on each other, and why the AI story is safe. Read §1 before proposing anything that touches a game's execution.                           |
| [`docs/DESIGN.md`](docs/DESIGN.md)             | The design language: Shark UI components, colour, typography, shape and the one glass surface, spacing, iconography, motion, interaction states, the accessibility floor, and voice. **UI changes are reviewed against this.**           |
| [`docs/SECURITY.md`](docs/SECURITY.md)         | The threat model and every security property, stated with its mechanism. If your change touches auth, permissions, the mod path or the agent surface, it has to be consistent with this file — or the file has to change in the same PR. |
| [`docs/MCP.md`](docs/MCP.md)                   | Every tool, what it does and what it explicitly does not. Adding or changing a tool means changing this.                                                                                                                                 |

Component reference for the client lives in
[`docs/reference/shark-ui-llms.txt`](docs/reference/shark-ui-llms.txt).

The deepest contract is not a document at all: it is `packages/shared`. The domain vocabulary, the
lifecycle state machine, the error codes and the zod schemas for every request and response live
there and are imported by both the API and the client, so a contract change is a compile error
rather than a runtime surprise. Change it deliberately, and change both sides in the same commit.
