# syntax=docker/dockerfile:1.7
#
# Platter, packaged.
#
# Two things make this awkward and both are handled deliberately:
#
#   1. Platter talks to the Docker socket, so the container needs the host's socket mounted and
#      its user needs to be able to read it. The compose file handles the group id; see the
#      comment there, and SECURITY.md for what socket access actually means.
#
#   2. `better-sqlite3` is a native module. It is compiled during install in the builder stage
#      against the same Node version the runtime uses, and copied across — building it in the
#      final stage would drag a C++ toolchain into the published image.

# --- Base ---------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# --- Dependencies -------------------------------------------------------------

FROM base AS deps
# python3/make/g++ are needed only to compile better-sqlite3, and stay out of the final image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/mcp/package.json apps/mcp/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/mods/package.json packages/mods/
COPY packages/diagnostics/package.json packages/diagnostics/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- Build --------------------------------------------------------------------

FROM deps AS build
COPY . .
RUN pnpm --filter @platter/web build \
 && pnpm --filter @platter/mcp build

# --- Runtime ------------------------------------------------------------------

FROM base AS runtime
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# Next's standalone output carries its own minimal node_modules, and for a pnpm workspace it
# preserves the workspace layout — so `server.js` lives at apps/web/server.js, not at the root.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

# The migrations are data, not code, and the runtime resolves them relative to the db package.
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle

# The bundled MCP server, plus the native modules it and the web app share.
COPY --from=build /app/apps/mcp/dist ./apps/mcp/dist
COPY --from=build /app/node_modules/.pnpm/better-sqlite3*/node_modules/better-sqlite3 \
     ./node_modules/better-sqlite3

# Platter writes to a single directory. Declaring it keeps a `docker run` without a mount from
# silently losing every world when the container is removed.
ENV PLATTER_DATA_DIR=/data
VOLUME ["/data"]

# Binding to 0.0.0.0 inside the container is correct — the container's network namespace is the
# boundary, and compose decides what is published on the host.
ENV PLATTER_HOST=0.0.0.0
ENV PLATTER_PORT=4880
ENV HOSTNAME=0.0.0.0
EXPOSE 4880

# tini reaps zombies and forwards signals, so SIGTERM reaches Next and the supervisor gets its
# chance to check-point the database and close RCON connections cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
