import { expect, test, type Page } from '@playwright/test';

/**
 * The product's central promise, end to end: create a Minecraft server, watch it reach
 * `running`, talk to it, stop it, and clean up after itself.
 *
 * Run against the **mock node driver**, which simulates the container lifecycle without
 * Docker. Every state transition asserted here is one the API really performed — nothing in
 * this file stubs a response. A green run means provisioning, the status feed, the console
 * socket and the power actions all agree with each other.
 *
 * Serial, because the three tests are three acts of one story: the server the first test
 * creates is the one the others drive and then delete.
 */

test.describe.configure({ mode: 'serial' });

/** Unique per run so a re-run never collides with a server the last one left behind. */
const SERVER_NAME = `E2E Survival ${Date.now().toString(36)}`;

const OWNER_EMAIL = process.env['E2E_EMAIL'] ?? 'owner@platter.local';
const OWNER_PASSWORD = process.env['E2E_PASSWORD'] ?? 'platter-dev-pass-9F2k';

/**
 * The game and type cards are Ark radios: the real `<input>` is visually hidden and the card
 * is its label, so the click goes to the label exactly as a person's would. The `visible=true`
 * filter matters — completed wizard steps stay mounted but hidden, and their prose mentions
 * the same words ("Paper" appears in the Minecraft blueprint's summary on step one).
 */
async function pickCard(page: Page, label: string): Promise<void> {
  await page.getByText(label, { exact: true }).locator('visible=true').first().click();
}

async function next(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Next' });
  await expect(button).toBeEnabled();
  await button.click();
}

test.describe('server lifecycle', () => {
  /*
   * One signed-in page for all three acts. `/auth/login` and `/auth/refresh` share a
   * ten-per-minute budget per address (`AUTH_RATE_LIMIT`), so signing in per test would
   * brute-force the API into 429s partway through the run — and it is not what a person
   * does either. They sign in once and then use the app.
   */
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    page = await context.newPage();
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER_EMAIL);
    await page.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  /*
   * Navigating by click rather than `page.goto`, throughout. It is what a person does, it
   * exercises client-side routing instead of a cold boot per hop, and each full page load
   * spends one `/auth/refresh` against an auth budget of ten a minute — a spec that reloads
   * for every assertion rate-limits itself into a false failure.
   */
  test('create a Minecraft server and watch it reach running', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'New server' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New server' })).toBeVisible();

    // ---- Step 1: the game -------------------------------------------------------------
    // A disabled control always says why.
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
    await expect(page.getByText('Pick a game to continue.')).toBeVisible();

    await pickCard(page, 'Minecraft: Java Edition');
    await next(page);

    // ---- Step 2: the server type ------------------------------------------------------
    await expect(page.getByRole('heading', { level: 2, name: 'Server type' })).toBeVisible();
    await pickCard(page, 'Paper');
    await next(page);

    // ---- Step 3: name and size --------------------------------------------------------
    await expect(page.getByRole('heading', { level: 2, name: 'Name and size' })).toBeVisible();
    await page.getByLabel('Server name').fill(SERVER_NAME);
    await next(page);

    // ---- Step 4: settings -------------------------------------------------------------
    // `level: 2` — the step heading. The panel also has an h3 "Game settings".
    await expect(page.getByRole('heading', { level: 2, name: 'Settings' })).toBeVisible();

    /*
     * The EULA is a required boolean the client treats as unanswered while off. The API
     * would accept `EULA=false` and hand back a server that installs and never boots, so
     * the client refuses first — and says so rather than silently disabling Create.
     */
    const eula = page.getByRole('checkbox', { name: /Minecraft EULA/i });
    await expect(eula).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByText(/Turn .I accept the Minecraft EULA. on before the server can start/i),
    ).toBeVisible();
    await eula.click();
    await expect(eula).toBeChecked();

    const create = page.getByRole('button', { name: 'Create server' });
    await expect(create).toBeEnabled();
    await create.click();

    // ---- Provisioning -----------------------------------------------------------------
    await page.waitForURL(/\/servers\/srv_[^/]+$/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1, name: SERVER_NAME })).toBeVisible();

    /*
     * The status is never faked — it shows whatever the API and the socket actually report,
     * and the mock driver really walks installing → starting → running. So this waits for
     * the word rather than asserting an instant success the product deliberately never claims.
     */
    await expect(page.getByText(/Installing|Starting|Running/).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Running', { exact: true }).first()).toBeVisible({
      timeout: 120_000,
    });
  });

  test('the console accepts a command while it is running', async () => {
    // Already on the server after creation — the console is its index tab.
    await expect(page).toHaveURL(/\/servers\/srv_[^/]+$/);

    // `role="log"` with a polite live region, per the accessibility floor.
    const consoleLog = page.getByRole('log');
    await expect(consoleLog).toBeVisible();

    const input = page.getByLabel(`Send a command to ${SERVER_NAME}`);
    await expect(input).toBeEnabled({ timeout: 60_000 });
    await input.fill('say hello from the e2e run');
    await input.press('Enter');

    // Clearing the field is the client's own receipt that the socket accepted the write.
    await expect(input).toHaveValue('');
  });

  test('stopping it reports the real state, then it can be deleted', async () => {
    await expect(page).toHaveURL(/\/servers\/srv_[^/]+$/);

    await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
    await expect(page.getByText('Offline', { exact: true }).first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByRole('button', { name: 'Start', exact: true }).first()).toBeEnabled({
      timeout: 30_000,
    });

    // ---- Deleting names what is lost --------------------------------------------------
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page
      .getByRole('button', { name: /^Delete server/i })
      .first()
      .click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(SERVER_NAME);
    await expect(dialog).toContainText(/backup|world|volume|permanent/i);

    // Escape closes it and nothing is destroyed — a confirmation that cannot be backed out
    // of is not a confirmation.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Now do it for real, so a re-run starts from a clean fleet.
    await page
      .getByRole('button', { name: /^Delete server/i })
      .first()
      .click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();

    const nameField = confirm.getByRole('textbox');
    if ((await nameField.count()) > 0) await nameField.first().fill(SERVER_NAME);

    await confirm
      .getByRole('button', { name: /delete/i })
      .last()
      .click();

    await page.waitForURL(/\/servers\/?$/, { timeout: 60_000 });
    await expect(page.getByRole('link', { name: SERVER_NAME })).toHaveCount(0);
  });
});
