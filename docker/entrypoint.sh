#!/bin/sh
# Bring the database up to date before the API starts.
#
# Running migrations here rather than from the app means a container that cannot migrate
# fails immediately and visibly, instead of starting up and throwing query errors later.
# It also keeps the app process free of a privilege it does not otherwise need.
set -eu

echo "platter: applying database migrations"
cd /app/apps/api

# Ask Node where the CLI is rather than hardcoding a path into node_modules. pnpm puts a
# workspace package's own dependency under `apps/api/node_modules`, not the root, so the
# old `../../node_modules/prisma/...` pointed at nothing in the built image and the
# container exited here — before it ever listened — on every boot.
PRISMA_CLI=$(node -e "process.stdout.write(require.resolve('prisma/build/index.js'))" 2>/dev/null || true)
if [ -z "$PRISMA_CLI" ]; then
  echo "platter: cannot find the prisma CLI; it must be a production dependency of @platter/api" >&2
  exit 1
fi

# `migrate deploy` applies committed migrations and never generates or resets. If the
# migrations directory has not been created yet (fresh checkout, dev image), fall back to
# `db push`, which brings an empty database up to the schema.
if [ -d prisma/migrations ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  node "$PRISMA_CLI" migrate deploy
else
  echo "platter: no migrations found, syncing schema directly"
  node "$PRISMA_CLI" db push --skip-generate
fi

cd /app

if [ "${SEED_ON_START:-0}" = "1" ]; then
  echo "platter: seeding"
  # Seeding is a convenience, not a prerequisite: the API reports `needsSetup` while no
  # account exists and the web client shows first-run setup, so an instance that could not
  # seed is still perfectly usable. `prisma/seed.ts` is not compiled into dist (the api
  # tsconfig has rootDir src) and tsx is a devDependency the production image prunes, so
  # both branches below can legitimately be missing. Under `set -e` that killed the
  # container before it ever listened; warn and carry on instead.
  if [ -f apps/api/prisma/seed.js ]; then
    node apps/api/prisma/seed.js || echo "platter: seeding failed, continuing to first-run setup"
  elif node -e "require.resolve('tsx')" 2>/dev/null; then
    node --import tsx apps/api/prisma/seed.ts || echo "platter: seeding failed, continuing to first-run setup"
  else
    echo "platter: no runnable seed in this image, continuing to first-run setup"
  fi
fi

echo "platter: starting"
exec "$@"
