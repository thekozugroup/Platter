import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end config.
 *
 * These specs drive the real client against a real API on the **mock node driver** — the
 * driver that simulates a container lifecycle without Docker (`apps/api/src/orchestration/
 * mock.ts`). That is the point: a server really is created, really transitions through
 * `installing` → `starting` → `running`, and the console socket really carries its output.
 * Stubbing the network here would only prove that the mocks agree with themselves.
 *
 * Both servers are assumed to be already running (`pnpm dev` with `DEFAULT_NODE_DRIVER=mock`),
 * and `webServer` below starts the web client if it is not. The API is deliberately *not*
 * started here: it needs a migrated, seeded database, and silently booting one against
 * whatever `DATABASE_URL` happens to be set would risk writing to a real install.
 */

const WEB_URL = process.env['E2E_WEB_URL'] ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  /* A provisioning run waits on real state transitions, so the default 30s is too tight. */
  timeout: 120_000,
  expect: { timeout: 15_000 },
  /* Serial: the specs share one seeded owner account and one node's port range. */
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],

  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5173',
    url: WEB_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
