# syntax=docker/dockerfile:1.7

# Platter ships as one image: the API serves the built SPA from the same origin, so a
# deployment is a single container plus a volume — no reverse proxy, no CORS, no second
# service to keep in sync. "Easily deployable" is the product promise; this file is where
# it is either kept or broken.

# ---------------------------------------------------------------------------
# Base — pnpm via corepack, pinned to the version in package.json
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# pnpm refuses to purge a modules directory without a TTY unless it believes it is in
# CI, and aborts the install instead (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY). A
# Docker build is exactly that situation, so say so once here.
ENV CI=true
# OpenSSL is a *build* requirement, not just a runtime one. Prisma chooses which query
# engine to emit by probing this machine for libssl, and node:22-bookworm-slim ships none
# (Node statically links its own). With nothing to find, Prisma guesses
# an `openssl-1.1.x` target, downloads that engine from binaries.prisma.sh, and produces a
# client the runtime stage cannot load. Installing libssl3 here makes the probe answer with
# this machine's 3.0.x target — `debian-openssl-3.0.x` on x86_64, `linux-arm64-openssl-3.0.x`
# on aarch64 — which is both correct and already bundled in @prisma/engines, so generation
# stops reaching for the network as well.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies — cached on the lockfile alone, so a source edit does not reinstall
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build — compiles shared, then the API against it, then the SPA
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
# Order is not arbitrary: the API's tsc resolves `@platter/shared` through its built
# `dist`, and both the API and the web typecheck against the generated Prisma types.
RUN pnpm --filter @platter/shared build \
 && pnpm --filter @platter/api exec prisma generate \
 && pnpm --filter @platter/api build \
 && pnpm --filter @platter/web build

# ---------------------------------------------------------------------------
# Production dependencies — a clean tree, never a pruned one
# ---------------------------------------------------------------------------
# Pruning the build stage in place (`pnpm install --prod` over an existing tree) does not
# work here: pnpm removes and rebuilds `node_modules`, which throws away the Prisma client
# generated above, and the virtual-store directory it rebuilds has a different peer hash
# (no `typescript` in the prod graph) so the old path cannot simply be copied back over.
# Installing prod-only into a fresh stage and generating Prisma *into that tree* is both
# smaller and unambiguous — the client is created exactly where the runtime will look.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
# `@platter/api...` selects the API plus the workspace packages it depends on, so the
# SPA's runtime dependencies (React, Radix, Recharts, CodeMirror) never enter the image —
# the web app ships as pre-built static assets and needs none of them at runtime.
# `--ignore-scripts` keeps node-gyp out of a slim image; nothing needed here builds from
# source, and Prisma's engines are shipped inside the `@prisma/engines` tarball rather
# than downloaded by a postinstall hook.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@platter/api..."
COPY apps/api/prisma ./apps/api/prisma
# `generate` never touches a database, but the datasource block still interpolates
# DATABASE_URL, so give it a value that is only ever read and discarded.
#
# The engine is then asserted rather than assumed. A wrong binary target still builds a
# perfectly healthy-looking image and only fails on the first query, inside a container,
# at deploy time — the most expensive place to find out. This turns that into a build
# failure with the offending filename in the message.
#
# The expected filename is derived from the architecture rather than hardcoded. Prisma names
# the engine after the platform it generated for, and the two names share no stem: x86_64
# gets `debian-openssl-3.0.x`, aarch64 gets `linux-arm64-openssl-3.0.x`. Naming only the
# amd64 one made this guard reject the *correct* arm64 engine and fail every arm64 build —
# found by building on an Ampere host, which is the machine the arm64 image exists to serve.
RUN case "$(uname -m)" in \
      aarch64 | arm64) ENGINE_TARGET=linux-arm64-openssl-3.0.x ;; \
      x86_64 | amd64) ENGINE_TARGET=debian-openssl-3.0.x ;; \
      *) echo "no known Prisma engine target for $(uname -m)" >&2; exit 1 ;; \
    esac \
 && DATABASE_URL="file:/tmp/generate.db" pnpm --filter @platter/api exec prisma generate \
 && CLIENT_DIR="$(node -e "process.stdout.write(require('node:path').join(require.resolve('.prisma/client', { paths: [require.resolve('@prisma/client', { paths: ['/app/apps/api'] })] }), '..'))")" \
 && if [ ! -f "$CLIENT_DIR/libquery_engine-$ENGINE_TARGET.so.node" ]; then \
      echo "prisma generated no $ENGINE_TARGET engine for this base image:" >&2; \
      ls -1 "$CLIENT_DIR" | grep libquery_engine >&2; \
      exit 1; \
    fi

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    BACKUP_DIR=/data/backups \
    WEB_ROOT=/app/web \
    DATABASE_URL=file:/data/platter.db

# openssl: node:22-bookworm-slim ships no libssl at all (Node statically links its own),
# and Prisma's query engine is dynamically linked against libssl.so.3 — without this the
# first query fails to load the engine. ca-certificates: outbound HTTPS to the Anthropic
# and mod-registry APIs. tini: without an init process, PID 1 ignores SIGTERM's default
# disposition and reaps no zombies — container stops would hang until Docker's kill
# timeout on every deploy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Run unprivileged. The one caveat is the Docker socket: to manage containers, this user
# must be in the group that owns /var/run/docker.sock on the host, which compose supplies
# via `group_add: [${DOCKER_GID}]` — see the security note in docker-compose.yml.
RUN groupadd --system --gid 1001 platter \
 && useradd --system --uid 1001 --gid platter --create-home platter

# node_modules comes from prod-deps, application code from build. pnpm's per-package
# `node_modules` are symlink farms pointing into the root `.pnpm` store, so every one of
# them has to come across or the links dangle — `packages/shared` included, because its
# compiled output imports zod and resolves it through its own directory.
COPY --from=prod-deps --chown=platter:platter /app/node_modules ./node_modules
COPY --from=prod-deps --chown=platter:platter /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps --chown=platter:platter /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build --chown=platter:platter /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=platter:platter /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=platter:platter /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=platter:platter /app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=platter:platter /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=platter:platter /app/apps/web/dist ./web
COPY --chown=platter:platter package.json pnpm-workspace.yaml ./
COPY --chown=platter:platter docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN mkdir -p /data/backups /data/servers && chown -R platter:platter /data
VOLUME ["/data"]

USER platter
EXPOSE 8080

# Uses the API's readiness endpoint rather than a bare TCP probe, so a container with a
# broken database reports unhealthy instead of merely "listening".
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/system/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
