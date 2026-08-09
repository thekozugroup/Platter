import { expect, signIn, test } from './support/fixtures';

/**
 * The same app on a 390px phone.
 *
 * Two pieces of chrome swap at the 768px breakpoint and they have to swap *together*: the
 * always-visible sidebar becomes a sheet behind a button, and a bottom bar appears carrying
 * the four destinations a thumb needs. Getting one without the other is the failure that
 * matters — a phone with no sidebar and no bottom bar has no navigation at all, and a phone
 * with both has two.
 *
 * This project runs with a real phone device profile, so touch and the narrow viewport are
 * the ones a phone actually gets rather than a squashed desktop. It signs in on its own
 * context for the same reason: the desktop worker's session is 1280px wide and reusing it
 * would test a resized desktop, which is not the thing.
 */

test.describe('on a phone', () => {
  test('the sidebar becomes a sheet, the bottom bar appears, and both navigate', async ({
    page,
  }) => {
    await signIn(page);

    // ---- The bottom bar is there, and it is navigation ---------------------------------
    const bottomBar = page.getByRole('navigation', { name: 'Primary' });
    await expect(bottomBar).toBeVisible();

    for (const destination of ['Home', 'Servers', 'New', 'Account']) {
      await expect(bottomBar.getByRole('tab', { name: destination })).toBeVisible();
    }
    // It knows where you are, rather than being four inert links.
    await expect(bottomBar.getByRole('tab', { name: 'Home' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Every destination is a real touch target. 44px is the floor; these are 56.
    const box = await bottomBar.getByRole('tab', { name: 'Servers' }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // ---- The sidebar is not on screen; a button opens it -------------------------------
    // Before the sheet is opened there is exactly one navigation landmark, which is the
    // bottom bar. Two would mean the desktop rail is still mounted and visible underneath.
    await expect(page.getByRole('navigation')).toHaveCount(1);

    const opener = page.getByRole('button', { name: 'Open navigation' });
    await expect(opener).toBeVisible();
    await expect(opener).toHaveAttribute('aria-expanded', 'false');

    await opener.tap();

    const sheet = page.getByRole('dialog', { name: 'Sidebar' });
    await expect(sheet).toBeVisible();
    // The full set of destinations, not a reduced one — the bottom bar is the shortcut, the
    // sheet is the whole map.
    await expect(sheet.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Servers' })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'New server' })).toBeVisible();

    // And it closes again without a mouse.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(opener).toHaveAttribute('aria-expanded', 'false');

    // ---- The bottom bar takes you somewhere, and follows where you go ------------------
    await bottomBar.getByRole('tab', { name: 'Servers' }).tap();

    await expect(page).toHaveURL(/\/servers$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Servers' })).toBeVisible();
    await expect(bottomBar.getByRole('tab', { name: 'Servers' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(bottomBar.getByRole('tab', { name: 'Home' })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    // Still there on the next screen. The bar is chrome, not a homepage widget.
    await expect(bottomBar).toBeVisible();
  });
});
