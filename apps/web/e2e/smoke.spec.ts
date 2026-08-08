import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Does the app come up, let a person in, and render their fleet?
 *
 * This is the spec that fails first when something structural breaks — a bad route, a
 * missing provider, an API contract that moved. It asserts on roles and accessible names
 * rather than CSS classes, so it keeps working when the design changes and breaks when the
 * *semantics* do, which is the only time a smoke test should break.
 *
 * One signed-in context is shared across the tests that need one. That is not a shortcut:
 * `/auth/login` and `/auth/refresh` share a ten-per-minute budget per address
 * (`AUTH_RATE_LIMIT` in `plugins/security.ts`), so a suite that signs in once per test
 * brute-forces its own API and starts failing on 429 — while a real person signs in once
 * and then uses the app. Reusing the session tests the thing people actually do.
 */

const OWNER_EMAIL = process.env['E2E_EMAIL'] ?? 'owner@platter.local';
const OWNER_PASSWORD = process.env['E2E_PASSWORD'] ?? 'platter-dev-pass-9F2k';

/** Fills and submits the sign-in form, and waits for the dashboard to actually render. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

/** A page that is already signed in, for a whole `describe` to share. */
export async function signedInPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  return page;
}

test.describe('unauthenticated', () => {
  test('a fresh install reports whether it still needs setup', async ({ request }) => {
    const response = await request.get('/api/v1/system/info');
    expect(response.ok()).toBeTruthy();

    const info = (await response.json()) as { needsSetup: boolean; version: string };
    expect(typeof info.needsSetup).toBe('boolean');
    expect(info.version).toBeTruthy();
  });

  test('setup redirects away once an owner exists', async ({ page, request }) => {
    /*
     * `/setup` is gated on `needsSetup`, and the gate is the interesting part: once an owner
     * exists the route must refuse to mint a second one.
     */
    const info = (await (await request.get('/api/v1/system/info')).json()) as {
      needsSetup: boolean;
    };
    test.skip(info.needsSetup, 'This install has no owner yet, so /setup is the correct screen.');

    await page.goto('/setup');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  test('an unauthenticated visitor is sent to sign in', async ({ page }) => {
    await page.goto('/servers');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  test('wrong credentials are refused in words, and the form stays usable', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER_EMAIL);
    await page.getByLabel('Password', { exact: true }).fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    // The voice rule, asserted: say what happened, never "Oops! Something went wrong".
    await expect(alert).not.toHaveText(/oops|something went wrong/i);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });
});

test.describe('signed in', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await signedInPage(browser);
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test('the dashboard renders its real chrome', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    // One primary action per view, and it is a verb.
    await expect(page.getByRole('link', { name: /New server/i }).first()).toBeVisible();

    // The sidebar is present at desktop width and names its destinations.
    await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  });

  test('the skip link is the first stop and reaches the main region', async () => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const focused = page.locator(':focus');
    await expect(focused).toHaveText(/skip/i);
    // It must be visible once focused, not merely present in the DOM.
    await expect(focused).toBeVisible();

    await focused.press('Enter');
    await expect(page.locator('#main-content')).toBeAttached();
  });

  /*
   * Navigation happens by clicking, not by `page.goto`, for two reasons. It is what a person
   * does — they follow the sidebar, they do not retype URLs — and it exercises client-side
   * routing rather than a cold boot of the whole app on every hop. (A `goto` per route also
   * spends one `/auth/refresh` each, and that shares the ten-per-minute auth budget.)
   *
   * The expected title is asserted per route rather than "some h1 exists": the sign-in screen
   * also has an h1, so the weaker check passes on a bounced session and hides exactly the
   * failure this test exists to catch.
   */
  async function visit(link: string, title: string): Promise<void> {
    await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByText(/not built yet/i)).toHaveCount(0);
  }

  test('every primary destination renders its own title, not a fallback', async () => {
    await page.goto('/');
    await visit('Servers', 'Servers');
    await visit('New server', 'New server');
  });

  test('the admin area is reachable and every screen is real', async () => {
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();

    await visit('Nodes', 'Nodes');
    await visit('Audit log', 'Audit log');
    await visit('Settings', 'Settings');
  });
});
