import { expect, test } from './support/fixtures';

/**
 * Getting to the thing you came to do, without a mouse.
 *
 * The chrome around every screen is a sidebar with a dozen destinations, and on a page with
 * servers in it the list grows. If the only route to the page's primary action is through
 * all of that, the keyboard path is technically complete and practically useless — so
 * Platter puts a skip link first, and the first stop inside the content region is the
 * primary action itself.
 *
 * That is the whole contract, and it is what this asserts: three keys from a cold page load
 * to the screen the button promises. Everything here is driven by `page.keyboard`; nothing
 * clicks, and nothing calls `.focus()` to help itself along.
 */

test('three keys from a fresh page to the primary action', async ({ owner: page }) => {
  // A real load, so focus starts where a browser puts it and not where the last spec left it.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  // ---- Tab: the skip link, by construction the first focusable thing on the page --------
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toHaveText(/skip to content/i);

  /*
   * And it has to actually appear. `sr-only focus:not-sr-only` means the difference between
   * a working skip link and a decorative one is whether the focus styles land, so this asks
   * for its real geometry rather than for `toBeVisible()` — a 1px clipped element passes
   * that and helps nobody.
   */
  const box = await focused.boundingBox();
  expect(box, 'the skip link must be rendered once focused').not.toBeNull();
  expect(box!.width).toBeGreaterThan(60);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.y).toBeGreaterThanOrEqual(0);

  // ---- Enter: focus lands in the content region, not merely the URL hash ---------------
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  // ---- Tab: the page's one primary action ---------------------------------------------
  await page.keyboard.press('Tab');
  const action = page.locator(':focus');
  await expect(action).toHaveText(/new server/i);
  // Inside the content region — i.e. this is the header's action, not the sidebar's link.
  await expect(page.locator('#main-content :focus')).toHaveCount(1);

  // ---- Enter: it does what a click would ----------------------------------------------
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/servers\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: 'New server' })).toBeVisible();
});
