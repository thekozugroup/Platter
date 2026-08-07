import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Platter is meant to be run, not deployed to a PaaS. `standalone` produces a self-contained
  // .next/standalone directory that the Docker image copies wholesale, which is what keeps the
  // published image small and the `docker compose up` path a single command.
  output: 'standalone',
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,

  // The workspace packages ship TypeScript source rather than a build artefact, so the app
  // compiles them itself. One source of truth, no build step before `pnpm dev`, and jumping to
  // a definition lands in real code instead of a `.d.ts`.
  transpilePackages: [
    '@platter/shared',
    '@platter/db',
    '@platter/core',
    '@platter/mods',
    '@platter/diagnostics',
  ],

  // dockerode, better-sqlite3 and tar-fs are native or CJS-heavy and must stay outside the
  // bundle. Leaving them in produces a build that fails at runtime with a missing .node binding
  // — a failure that only shows up in production builds, never in dev.
  serverExternalPackages: ['dockerode', 'better-sqlite3', 'tar-fs', 'ssh2', 'cpu-features'],

  typescript: { ignoreBuildErrors: false },

  // Mod icons come from the two providers' CDNs and nowhere else.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.modrinth.com' },
      { protocol: 'https', hostname: 'media.forgecdn.net' },
    ],
  },

  // Local-first: nothing here should be phoning home.
  poweredByHeader: false,

  // In development Next refuses cross-origin requests for its own assets, and it treats
  // `127.0.0.1` and `localhost` as different origins. Platter binds to 127.0.0.1 by default, so
  // without this every asset 403s, nothing hydrates, and the page renders as a lifeless shell —
  // with the only clue buried in the browser console.
  allowedDevOrigins: ['127.0.0.1', 'localhost', '0.0.0.0', '[::1]'],
};

export default config;
