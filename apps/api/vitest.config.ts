import { defineConfig } from 'vitest/config';

/**
 * The suite talks to a real SQLite database and a real (mock-backed) orchestration driver,
 * which drives every choice here.
 *
 * `fileParallelism: false` is the important one. Each file gets its own database, but they
 * also share process-wide singletons through the module graph — the driver registry, the
 * log hubs, the mDNS advertisement map — and several exercise timers. Running them
 * concurrently turns those into a source of order-dependent flakes that cost far more to
 * chase than the wall clock saved.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./src/test/global-setup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // One file at a time, and a fresh process per file so a module-level cache cannot
    // leak across suites.
    fileParallelism: false,
    pool: 'forks',
    // Provisioning waits on the mock driver's simulated pulls and boots; the default 5s
    // is too tight for the lifecycle suites and produces failures that look like bugs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    // `main.ts` binds a socket at import; nothing may sweep it into a coverage pass.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/test/**', 'src/**/__tests__/**'],
    },
  },
});
