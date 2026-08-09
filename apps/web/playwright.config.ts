import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end config.
 *
 * `pnpm --filter @platter/web test:e2e` brings the whole product up itself: a fake Modrinth
 * on loopback, an API on the **mock node driver** against a database created and migrated
 * for this run alone, and the Vite client proxying to it. Nothing has to be running first
 * and nothing outside the run's temp directory is written to, so this works from a clean
 * checkout and on a machine that is also running Platter for real.
 *
 * Nothing here stubs a Platter response. A server really is created, the API really walks it
 * through `installing → starting → running` (`apps/api/src/orchestration/mock.ts`), the
 * console socket really carries its output, and the mod proposal really goes through the
 * resolver. Intercepting the network would only prove that the mocks agree with themselves.
 *
 * Ports are deliberately not the development ones — 5199/8791/8793 rather than 5173/8080 —
 * so a run cannot attach to, or fight with, a `pnpm dev` in another terminal.
 */

const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 5199);
const API_PORT = Number(process.env['E2E_API_PORT'] ?? 8791);
const MODRINTH_PORT = Number(process.env['E2E_MODRINTH_PORT'] ?? 8793);

const WEB_URL = process.env['E2E_WEB_URL'] ?? `http://127.0.0.1:${WEB_PORT}`;

/** Shared by every server this config starts, so they agree on where to find each other. */
const stackEnv = {
  E2E_WEB_PORT: String(WEB_PORT),
  E2E_API_PORT: String(API_PORT),
  E2E_MODRINTH_PORT: String(MODRINTH_PORT),
  MODRINTH_STUB_PORT: String(MODRINTH_PORT),
};

export default defineConfig({
  testDir: './e2e',
  /* Provisioning waits on real state transitions, so the 30s default is too tight. */
  timeout: 120_000,
  expect: { timeout: 15_000 },
  /*
   * One worker, in file order. Not a concession: the node in the run has 16 GB and the
   * Minecraft blueprint asks for 4 GB, so four servers at once exhaust it — and the signed-in
   * session is shared per worker precisely so the suite does not spend the API's
   * ten-per-minute auth budget on repeated sign-ins.
   */
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    /*
     * First run comes first, and everything else declares it as a dependency.
     *
     * The run's database is migrated but not seeded, so the install genuinely has no owner —
     * which is the only state in which "create the owner account" is a journey at all. The
     * account it creates is what the other projects sign in as. That is a *declared*
     * dependency on install-level bootstrap, not one spec quietly reading another's leftover
     * data: every spec still creates and destroys its own servers, and `pnpm test:e2e
     * --grep console` still works because Playwright runs the dependency first.
     *
     * `retries: 0` here for the same reason: a second attempt would meet an install that has
     * already been set up, and fail for a reason that has nothing to do with the code.
     */
    {
      name: 'first-run',
      testMatch: /first-run\.spec\.ts/,
      retries: 0,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'desktop',
      testIgnore: [/first-run\.spec\.ts/, /mobile\.spec\.ts/],
      dependencies: ['first-run'],
      retries: process.env['CI'] ? 1 : 0,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      /* A real phone viewport, with touch, so the sheet and the bottom bar are the ones a
         phone actually gets rather than a narrow desktop. */
      name: 'mobile',
      testMatch: /mobile\.spec\.ts/,
      dependencies: ['first-run'],
      retries: process.env['CI'] ? 1 : 0,
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
  ],

  /*
   * `reuseExistingServer: false` everywhere. Reusing would hand the first-run journey an
   * install that already has an owner, and would let one run's servers and proposals leak
   * into the next — the two things this suite is most careful about.
   */
  webServer: [
    {
      command: 'node e2e/support/modrinth-stub.mjs',
      url: `http://127.0.0.1:${MODRINTH_PORT}/health`,
      env: stackEnv,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node e2e/support/start-api.mjs',
      url: `http://127.0.0.1:${API_PORT}/api/v1/system/info`,
      env: stackEnv,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      env: { ...stackEnv, VITE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
