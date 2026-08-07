import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    // Only used by `drizzle-kit studio` / `push`. Migrations are generated statically and
    // applied at runtime by `applyMigrations()`, so this path is a developer convenience.
    url: process.env.PLATTER_DB_URL ?? './.drizzle-dev.db',
  },
  strict: true,
  verbose: true,
});
