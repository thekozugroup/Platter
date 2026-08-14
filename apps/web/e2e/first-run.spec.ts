import { expect, test } from '@playwright/test';
import { OWNER } from './support/fixtures';

/**
 * The first ninety seconds of a new installation.
 *
 * Somebody has just run `docker compose up`. Nobody has ever signed in. What they should get
 * is one screen that explains what the account they are about to make *is*, and then the
 * dashboard — not a login form for credentials that do not exist yet.
 *
 * This runs against an install whose database was migrated and left empty on purpose
 * (`support/start-api.mjs`), because "first run" is only a journey when it really is the
 * first run. The owner it creates is the account the rest of the suite signs in as; see the
 * note on `projects` in `playwright.config.ts` for why that is a declared dependency rather
 * than leftover data.
 *
 * Serial, because the second test is the consequence of the first: once an owner exists, the
 * door has to close behind them.
 */

test.describe.configure({ mode: 'serial' });

interface SystemInfo {
  needsSetup: boolean;
  version: string;
  counts: { users: number; servers: number; nodes: number };
}

test('a fresh install sends you to setup, and the owner you make lands on the dashboard', async ({
  page,
  request,
}) => {
  const before = (await (await request.get('/api/v1/system/info')).json()) as SystemInfo;
  expect(
    before.needsSetup,
    'This project must run against an install with no owner. Check start-api.mjs is not seeding.',
  ).toBe(true);
  expect(before.counts.users).toBe(0);

  // Whatever a stranger opens, an unconfigured install takes them to the same place. Not to
  // a sign-in form: there is nothing to sign in with.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Create the owner account' }),
  ).toBeVisible();

  // The screen says what this account is for before asking for anything.
  await expect(page.getByText(/The first account owns it/i)).toBeVisible();

  await page.getByLabel('Your name').fill(OWNER.displayName);
  await page.getByLabel('Username').fill(OWNER.username);
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);

  // The password meter's answer is a word and a sentence, not a coloured bar on its own.
  await expect(page.getByText('Strong.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create account and sign in' }).click();

  // One step: creating the account signs you in. No "now please log in" round trip.
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: `Account: ${OWNER.displayName}` })).toBeVisible();

  // The account exists on the server, not only in this tab.
  const after = (await (await request.get('/api/v1/system/info')).json()) as SystemInfo;
  expect(after.needsSetup).toBe(false);
  expect(after.counts.users).toBe(1);
  // A node is provisioned at boot, so the dashboard's first action is actually usable.
  expect(after.counts.nodes).toBeGreaterThan(0);
});

test('setup will not mint a second owner once one exists', async ({ page }) => {
  await page.goto('/setup');

  // The route is gated on the install's state, not on being signed out — otherwise anyone
  // who reached this URL first could take the installation.
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
});
