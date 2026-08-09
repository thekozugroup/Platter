import {
  expect,
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * Shared ground for the end-to-end suite.
 *
 * Two things here are load-bearing and worth reading before adding a spec.
 *
 * **One sign-in per worker.** `/auth/login` and `/auth/refresh` share a ten-per-minute
 * budget per source address (`AUTH_RATE_LIMIT`, `apps/api/src/plugins/security.ts`). A suite
 * that opens a fresh context and signs in for every test brute-forces its own API and starts
 * failing on 429 somewhere in the middle — a failure that looks like a product bug and is
 * not. So the signed-in page is a *worker* fixture: it is created once, and every spec in
 * the worker drives it. That is also what a person does. They sign in once and then use the
 * app, navigating by clicking rather than by retyping URLs, and the specs do the same:
 * `page.goto` costs a full document load and one refresh against that budget, a click costs
 * neither.
 *
 * **Nothing is left behind.** A spec creates the servers it needs and deletes them in its own
 * `afterAll`, through `platter` rather than through the UI, so the cleanup still happens when
 * the spec failed half way. That is not tidiness: the run's node has 16 GB and the Minecraft
 * blueprint asks for 4 GB, so four abandoned servers make the next spec fail on capacity —
 * with an error about memory that has nothing to do with what actually broke.
 */

/**
 * Where the client is. Kept in step with `playwright.config.ts` through the same two
 * variables, so overriding the port in one place does not leave `PlatterApi` talking to a
 * different stack than the browser is.
 */
export const WEB_URL =
  process.env['E2E_WEB_URL'] ?? `http://127.0.0.1:${process.env['E2E_WEB_PORT'] ?? 5199}`;

/**
 * The account the `first-run` spec creates and every other spec signs in as.
 *
 * The install starts with no owner at all (see `support/start-api.mjs`), because a first-run
 * journey is only a journey on an install that has never been set up. Creating that account
 * is therefore a declared project dependency, not data one spec happens to leave lying
 * around for another: see `projects` in `playwright.config.ts`.
 */
export const OWNER = {
  displayName: 'Robin Ellis',
  username: 'robin',
  email: 'robin@platter.test',
  /** Twelve characters minimum, and not on the API's weak list (`passwordSchema`). */
  password: 'kettle-harbour-slate-92',
} as const;

// ---------------------------------------------------------------------------------------
// Interacting with the real controls
// ---------------------------------------------------------------------------------------

/**
 * Chooses a card-shaped radio or flips a switch, by clicking the thing a person clicks.
 *
 * Ark renders these as a real `<input>` inside a `<label>` that covers it, so Playwright's
 * `check()` refuses: the input is the accessible element but the label is what receives the
 * pointer. Clicking the label is both what actually happens in the product and the only
 * hit-testable target — and the assertion afterwards is still on the input's checked state,
 * which is the semantics, not the markup.
 */
export async function choose(control: Locator): Promise<void> {
  await control.locator('xpath=ancestor::label[1]').click();
  await expect(control).toBeChecked();
}

/** Reads the value out of a `CopyField`, which is a labelled group around a `<code>`. */
export function copyFieldValue(page: Page, label: string): Locator {
  return page.getByRole('group', { name: label }).locator('code').first();
}

/**
 * Signs in and waits for the dashboard, so a caller never races the silent refresh.
 *
 * Exported because the mobile journey needs its own context at 390px and cannot share the
 * desktop one.
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

// ---------------------------------------------------------------------------------------
// The API, as an agent or an operator's script would use it
// ---------------------------------------------------------------------------------------

export interface InstalledMod {
  title: string;
  target: string;
  filename: string;
}

/**
 * A thin authenticated client for the setup and teardown a spec cannot reasonably do through
 * the UI: raising a proposal the way an MCP agent does, and guaranteeing a server is gone
 * even when the spec that created it failed half way.
 *
 * Assertions never come from here. Everything a spec claims about the product is claimed
 * about what a person can see on the screen; this is only how the world is arranged before
 * they look at it.
 */
export class PlatterApi {
  private constructor(
    private readonly http: APIRequestContext,
    private readonly token: string,
  ) {}

  static async signIn(): Promise<PlatterApi> {
    const http = await playwrightRequest.newContext({ baseURL: WEB_URL });
    const response = await http.post('/api/v1/auth/login', {
      data: { email: OWNER.email, password: OWNER.password },
    });
    if (!response.ok()) {
      throw new Error(`API sign-in failed: ${response.status()} ${await response.text()}`);
    }
    const body = (await response.json()) as { accessToken: string };
    return new PlatterApi(http, body.accessToken);
  }

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async dispose(): Promise<void> {
    await this.http.dispose();
  }

  /**
   * A Paper server, for the specs whose subject is not the create wizard.
   *
   * `server-lifecycle.spec.ts` owns proving that a person can make one of these by hand;
   * everywhere else, spending ninety seconds and a screenful of clicks to arrive at the same
   * row would test the wizard twice and the actual subject once.
   */
  async createPaperServer(name: string): Promise<string> {
    const response = await this.http.post('/api/v1/servers', {
      headers: this.headers,
      data: {
        name,
        description: '',
        blueprintKey: 'minecraft-java',
        limits: { memoryMb: 4096, cpuCores: 2, diskMb: 10_240 },
        variables: { TYPE: 'PAPER', VERSION: 'LATEST', EULA: 'true' },
        ports: {},
        autoStart: false,
        autoRestart: false,
        startOnCreate: false,
      },
    });
    if (!response.ok()) {
      throw new Error(`create server failed: ${response.status()} ${await response.text()}`);
    }
    return ((await response.json()) as { id: string }).id;
  }

  /**
   * The host the primary allocation binds — `0.0.0.0` in every normal deployment.
   *
   * Exists so the lifecycle spec can prove its own address assertion is not vacuous: a
   * "never shows a bind address" check is worth nothing unless there really is a bind
   * address in the record the screen was built from.
   */
  async primaryBindHost(serverId: string): Promise<string> {
    const response = await this.http.get(`/api/v1/servers/${serverId}`, {
      headers: this.headers,
    });
    if (!response.ok()) {
      throw new Error(`get server failed: ${response.status()} ${await response.text()}`);
    }
    const body = (await response.json()) as {
      allocations: Array<{ primary: boolean; hostIp: string }>;
    };
    const primary = body.allocations.find((allocation) => allocation.primary);
    if (!primary) throw new Error('server has no primary allocation');
    return primary.hostIp;
  }

  /** Best effort: a server that is already gone is the outcome we wanted. */
  async deleteServer(serverId: string): Promise<void> {
    await this.http.delete(`/api/v1/servers/${serverId}?deleteBackups=true`, {
      headers: this.headers,
    });
  }

  /** What is actually on disk. The proposal journey's real question. */
  async installedMods(serverId: string): Promise<InstalledMod[]> {
    const response = await this.http.get(`/api/v1/servers/${serverId}/mods/installed`, {
      headers: this.headers,
    });
    if (!response.ok()) {
      throw new Error(`installed mods failed: ${response.status()} ${await response.text()}`);
    }
    const body = (await response.json()) as { data: InstalledMod[] };
    return body.data;
  }

  /**
   * Raises a proposal exactly as `propose_mod` over MCP does — the API has no other way in,
   * and no way at all to install without a human approval.
   */
  async proposeMod(
    serverId: string,
    input: { source: 'modrinth' | 'curseforge'; project: string; rationale: string },
  ): Promise<{ id: string; title: string; versionNumber: string }> {
    const response = await this.http.post(`/api/v1/servers/${serverId}/proposals`, {
      headers: this.headers,
      data: input,
    });
    if (!response.ok()) {
      throw new Error(`propose failed: ${response.status()} ${await response.text()}`);
    }
    return (await response.json()) as { id: string; title: string; versionNumber: string };
  }
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

interface WorkerFixtures {
  /** Signed in once for the whole worker. Use `owner` in specs, not this. */
  ownerSession: Page;
  platter: PlatterApi;
}

interface TestFixtures {
  /** The signed-in page, with a screenshot attached to the report if the test fails. */
  owner: Page;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  /*
   * The `use` callback is named `run` throughout. Playwright does not care what it is
   * called, and `use(...)` inside a plain arrow function reads to `react-hooks/rules-of-hooks`
   * as a React hook called outside a component — a lint failure with nothing behind it.
   */
  ownerSession: [
    async ({ browser }, run) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await signIn(page);
      await run(page);
      await context.close();
    },
    { scope: 'worker' },
  ],

  platter: [
    // Playwright insists the first parameter is a destructuring pattern even when a fixture
    // depends on nothing, which is the one case `no-empty-pattern` exists to catch.
    // eslint-disable-next-line no-empty-pattern
    async ({}, run) => {
      const api = await PlatterApi.signIn();
      await run(api);
      await api.dispose();
    },
    { scope: 'worker' },
  ],

  owner: async ({ ownerSession }, run, testInfo) => {
    await run(ownerSession);
    if (testInfo.status !== testInfo.expectedStatus) {
      // The worker-scoped context is outside Playwright's automatic artifacts, and a failure
      // with no picture of the screen is a failure nobody can act on from a CI log.
      await testInfo.attach('screen-at-failure.png', {
        body: await ownerSession.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    }
  },
});

export { expect } from '@playwright/test';
