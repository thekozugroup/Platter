import { choose, copyFieldValue, expect, test } from './support/fixtures';

/**
 * The product's central promise, end to end: make a Paper server, watch it come up, hand
 * someone an address that works, talk to it, stop it, and take it away again.
 *
 * Run against the mock node driver, so every transition asserted here is one the API really
 * performed. Nothing in this file intercepts a response.
 *
 * Three tests, serial, because they are three acts of one story about one server — the same
 * server a person would keep in front of them. The `afterAll` is a safety net, not the
 * cleanup: the last act deletes the server through the UI, which is the point of the act.
 * Without the net, a failure in act one strands 4 GB of the run node's 16 GB and the *next*
 * spec fails on capacity, complaining about memory instead of about what broke.
 */

test.describe.configure({ mode: 'serial' });

/** Unique per run, so a name is never ambiguous in a confirmation dialog or a list. */
const SERVER_NAME = `E2E Survival ${Date.now().toString(36)}`;

/** Byte-for-byte what a Paper server prints when it has finished booting. */
const READY_LINE = 'Done (1.284s)! For help, type "help"';

const COMMAND = 'say hello from the end-to-end run';

/** Filled by the first act; used by the last one and by the safety net. */
let serverId = '';

test.describe('a Minecraft server, from nothing to gone', () => {
  test.afterAll(async ({ platter }) => {
    if (serverId) await platter.deleteServer(serverId);
  });

  test('create a Paper server and watch it reach running', async ({ owner: page, platter }) => {
    await page.getByRole('navigation').getByRole('link', { name: 'New server' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New server' })).toBeVisible();

    // ---- Step 1: which game --------------------------------------------------------
    // A disabled control always says why it is disabled.
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
    await expect(page.getByText('Pick a game to continue.')).toBeVisible();

    await choose(page.getByRole('radio', { name: /Minecraft Java Edition/ }));
    await page.getByRole('button', { name: 'Next' }).click();

    // ---- Step 2: which server type -------------------------------------------------
    await expect(page.getByRole('heading', { level: 2, name: 'Server type' })).toBeVisible();
    await choose(page.getByRole('radio', { name: /^Paper/ }));
    await page.getByRole('button', { name: 'Next' }).click();

    // ---- Step 3: name and size -----------------------------------------------------
    await expect(page.getByRole('heading', { level: 2, name: 'Name and size' })).toBeVisible();
    await page.getByLabel('Server name').fill(SERVER_NAME);
    await page.getByRole('button', { name: 'Next' }).click();

    // ---- Step 4: settings ----------------------------------------------------------
    // `level: 2` is the step heading; the panel below also has an h3 "Game settings".
    await expect(page.getByRole('heading', { level: 2, name: 'Settings' })).toBeVisible();

    /*
     * The EULA is a required boolean the client treats as unanswered while it is off. The API
     * would accept `EULA=false` and hand back a server that installs and never boots, so the
     * client refuses first — and says so, rather than silently disabling Create.
     */
    const eula = page.getByRole('checkbox', { name: /Minecraft EULA/i });
    await expect(eula).toHaveAttribute('aria-invalid', 'true');
    await choose(eula);

    const create = page.getByRole('button', { name: 'Create server' });
    await expect(create).toBeEnabled();
    await create.click();

    // ---- Provisioning --------------------------------------------------------------
    await page.waitForURL(/\/servers\/srv_[^/]+$/);
    serverId = /\/servers\/(srv_[^/?#]+)/.exec(page.url())?.[1] ?? '';
    expect(serverId).not.toBe('');

    await expect(page.getByRole('heading', { level: 1, name: SERVER_NAME })).toBeVisible();

    /*
     * The status is never faked — it shows what the API and the socket actually report, and
     * the mock driver really walks installing → starting → running. So this waits for the
     * word rather than asserting an instant success the product deliberately never claims.
     */
    await expect(page.getByText('Running', { exact: true }).first()).toBeVisible({
      timeout: 90_000,
    });

    // ---- The address a player is given ---------------------------------------------
    /*
     * The single most consequential string in the product, and the easiest to get wrong: the
     * allocation on the server record binds `0.0.0.0`, which is where the container listens
     * and not anywhere a client can dial. Handing that to someone next to a copy button is a
     * value guaranteed to fail with nothing on screen to explain why.
     */
    const address = copyFieldValue(page, 'Connect address');
    await expect(address).toBeVisible();

    /*
     * First, prove the check below can fail. A "never shows a bind address" assertion is
     * worth nothing unless there really is one in the record this header was built from —
     * and there is: the allocation binds a wildcard so the kernel accepts traffic on every
     * interface.
     */
    const bind = await platter.primaryBindHost(serverId);
    expect(
      bind,
      'the allocation should bind a wildcard, or the next assertion proves nothing',
    ).toMatch(/^(0\.0\.0\.0|::)$/);

    const shown = ((await address.textContent()) ?? '').trim();
    expect(shown).not.toBe('');
    expect(shown, 'the connect address must not be the bind address').not.toContain(bind);
    expect(shown, 'the connect address must not be a wildcard host').not.toMatch(
      /^(\[?::(ffff:0\.0\.0\.0)?\]?|0\.0\.0\.0|0:0:0:0:0:0:0:0)(:\d+)?$/,
    );
    // Either a friendly hostname or host:port — and in both cases something dialable.
    expect(shown).toMatch(/^[A-Za-z0-9.\-[\]:]+$/);

    await expect(page.getByRole('button', { name: 'Copy connect address' })).toBeVisible();
  });

  test('the console carries the server’s own output and takes a command', async ({
    owner: page,
  }) => {
    // Still on the server after creation — the console is its index tab.
    await expect(page).toHaveURL(new RegExp(`/servers/${serverId}$`));

    // A polite live region, per the accessibility floor.
    const consoleLog = page.getByRole('log');
    await expect(consoleLog).toBeVisible();

    // A line the *server* wrote, not one Platter narrated about itself. If the socket were
    // dead, the Platter-authored install lines would still be there and this would not.
    await expect(consoleLog).toContainText(READY_LINE, { timeout: 60_000 });

    const input = page.getByLabel(`Send a command to ${SERVER_NAME}`);
    await expect(input).toBeEnabled({ timeout: 60_000 });
    await input.fill(COMMAND);
    await input.press('Enter');

    // Clearing the field is the client's receipt that the write was accepted…
    await expect(input).toHaveValue('');
    // …and the command coming back down the socket is the server's.
    await expect(consoleLog).toContainText(COMMAND);
  });

  test('stopping it reports the real state, and deleting it says what is lost', async ({
    owner: page,
  }) => {
    await page.getByRole('button', { name: 'Stop', exact: true }).first().click();

    await expect(page.getByText('Offline', { exact: true }).first()).toBeVisible({
      timeout: 90_000,
    });
    // The row rearranges itself around what is now possible.
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();

    // ---- Deleting names the server, and what goes with it --------------------------
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: `Delete ${SERVER_NAME}` }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText(`Delete ${SERVER_NAME}?`);
    await expect(dialog).toContainText(/data volume is destroyed/i);
    await expect(dialog).toContainText(/every backup/i);

    // Confirming is an act, not a reflex: the button will not fire until the name is typed.
    const confirm = dialog.getByRole('button', { name: 'Delete this server' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(`Type ${SERVER_NAME} to confirm`).fill('not the right name');
    await expect(confirm).toBeDisabled();

    // And it can be backed out of. A confirmation you cannot escape is not a confirmation.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: SERVER_NAME })).toBeVisible();

    // Now mean it.
    await page.getByRole('button', { name: `Delete ${SERVER_NAME}` }).click();
    const second = page.getByRole('alertdialog');
    await second.getByLabel(`Type ${SERVER_NAME} to confirm`).fill(SERVER_NAME);
    await second.getByRole('button', { name: 'Delete this server' }).click();

    await page.waitForURL(/\/servers\/?$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Servers' })).toBeVisible();
    await expect(page.getByRole('link', { name: SERVER_NAME })).toHaveCount(0);
    // The sidebar is the other place it was listed, and it has to agree.
    await expect(page.getByRole('navigation').getByRole('link', { name: SERVER_NAME })).toHaveCount(
      0,
    );

    serverId = '';
  });
});
