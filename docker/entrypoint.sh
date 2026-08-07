#!/bin/sh
# Bring the database up to date before the API starts.
#
# Running migrations here rather than from the app means a container that cannot migrate
# fails immediately and visibly, instead of starting up and throwing query errors later.
# It also keeps the app process free of a privilege it does not otherwise need.
set -eu

echo "platter: applying database migrations"
cd /app/apps/api

# `migrate deploy` applies committed migrations and never generates or resets. If the
# migrations directory has not been created yet (fresh checkout, dev image), fall back to
# `db push`, which brings an empty database up to the schema.
if [ -d prisma/migrations ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  node ../../node_modules/prisma/build/index.js migrate deploy
else
  echo "platter: no migrations found, syncing schema directly"
  node ../../node_modules/prisma/build/index.js db push --skip-generate
fi

cd /app

if [ "${SEED_ON_START:-0}" = "1" ]; then
  echo "platter: seeding"
  node apps/api/dist/../prisma/seed.js 2>/dev/null || node --import tsx apps/api/prisma/seed.ts
fi

echo "platter: starting"
exec "$@"
