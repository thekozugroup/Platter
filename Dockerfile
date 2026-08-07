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
# Build
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @platter/shared build \
 && pnpm --filter @platter/api exec prisma generate \
 && pnpm --filter @platter/api build \
 && pnpm --filter @platter/web build

# Reinstall as production-only so the runtime image carries no build tooling. Prisma's
# generated client lives in node_modules, so it is copied across explicitly afterwards.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

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

# openssl: Prisma's query engine needs it. tini: without an init process, PID 1 ignores
# SIGTERM's default disposition and reaps no zombies — container stops would hang until
# Docker's kill timeout on every deploy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Run unprivileged. The one caveat is the Docker socket: to manage containers, this user
# must be in the group that owns /var/run/docker.sock on the host. compose sets that via
# `group_add`, and DEPLOYMENT.md explains the trade-off and the rootless alternative.
RUN groupadd --system --gid 1001 platter \
 && useradd --system --uid 1001 --gid platter --create-home platter

COPY --from=build --chown=platter:platter /app/node_modules ./node_modules
COPY --from=build --chown=platter:platter /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=platter:platter /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=platter:platter /app/apps/api/node_modules ./apps/api/node_modules
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
