import { expect, test } from './support/fixtures';

/**
 * "The agent can propose a mod. It cannot install one."
 *
 * That sentence is the security claim on the front of the README, and this is the spec that
 * has to be able to fail if it stops being true. So the shape of the test mirrors the shape
 * of the claim:
 *
 *   - the suggestion is raised the way an agent raises one — `POST /servers/:id/proposals`,
 *     the only entry point the MCP module has;
 *   - everything after that is what a *person* sees and does in the browser;
 *   - and the question asked between every step is the same one, asked of the server rather
 *     than of the screen: **is anything on disk yet?**
 *
 * The screen it walks is the review half of the mod flow, not the browsing half. A person who
 * searched for a mod and opened it is not reviewing anything and gets a plain "Add to server"
 * (`components/mods/mod-detail-sheet.tsx`); this queue is for the case where somebody *else*
 * chose, and the decision is the whole content of the screen.
 *
 * The registry behind it is a fake Modrinth on loopback (`support/modrinth-stub.mjs`), so
 * the run needs no network. The resolver, the snapshot, the digest and the review panel are
 * all the real ones.
 *
 * Serial: three acts about one suggestion, and the third disposes of it.
 */

test.describe.configure({ mode: 'serial' });

const SERVER_NAME = `E2E Mods ${Date.now().toString(36)}`;
const MOD_TITLE = 'Lantern Lights';
const MOD_VERSION = '1.4.0';
const MOD_FILE = 'plugins/lantern-lights-1.4.0.jar';
const RATIONALE = 'Spawn-proofing without a command block, which is what was asked for.';

let serverId = '';

test.describe('a mod an agent suggested', () => {
  test.beforeAll(async ({ platter, ownerSession }) => {
    serverId = await platter.createPaperServer(SERVER_NAME);

    // Exactly what `propose_mod` does over MCP: snapshot the project and a version, and
    // create a pending record. It installs nothing, and there is no endpoint that would.
    const proposal = await platter.proposeMod(serverId, {
      source: 'modrinth',
      project: 'lantern-lights',
      rationale: RATIONALE,
    });
    expect(proposal.title).toBe(MOD_TITLE);
    expect(proposal.versionNumber).toBe(MOD_VERSION);

    await ownerSession.goto(`/servers/${serverId}/mods`);
  });

  test.afterAll(async ({ platter }) => {
    if (serverId) await platter.deleteServer(serverId);
  });

  test('renders the whole mod, and says plainly that nothing has been added', async ({
    owner: page,
    platter,
  }) => {
    /*
     * Scoped to the suggestion section rather than the page. The registry browser lower down
     * shows the same project as a search result, so an unscoped `getByText('e2e-fixtures')`
     * matches both — and would keep passing if the review panel stopped rendering the author
     * entirely, which is exactly the regression this line exists to catch.
     */
    const review = page.getByRole('region', { name: 'Suggested for you' });
    await expect(review).toBeVisible();

    // The first thing on the panel, before anything else, is the standing statement.
    await expect(review.getByText('Nothing has been added')).toBeVisible();
    await expect(
      review.getByText(/No file has been downloaded, nothing has been written to/i),
    ).toBeVisible();

    // Who asked, and why. Somebody with no reason cannot decide anything.
    await expect(review.getByText(RATIONALE)).toBeVisible();

    // What it would do, in plain words first and then down to the file.
    await expect(review.getByRole('heading', { name: 'What this would do' })).toBeVisible();
    await expect(review.getByText(`Adds ${MOD_TITLE}`)).toBeVisible();
    await expect(review.getByText(MOD_FILE)).toBeVisible();

    // The mod itself — not a summary of it. Somebody who has to open Modrinth to judge
    // whether a project is real is somebody who stops bothering, and that is how a safety
    // gate quietly stops working.
    await expect(review.getByText(MOD_TITLE).first()).toBeVisible();
    await expect(review.getByText('e2e-fixtures', { exact: true })).toBeVisible();
    await expect(review.getByText('MIT License')).toBeVisible();
    await expect(review.getByText(/keep hostile mobs from spawning/i)).toBeVisible();
    // Which servers it is for, so "will this even run here" is answerable on the page.
    await expect(review.getByText('paper', { exact: true }).first()).toBeVisible();

    // No shortcut anywhere on the screen. Two buttons, and nothing that installs on its own.
    await expect(page.getByRole('button', { name: /^Install\b/ })).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Add to server' })).toBeVisible();
    await expect(review.getByRole('button', { name: 'Dismiss' })).toBeVisible();

    // Said on the screen…
    const installed = page.getByRole('region', { name: 'On this server' });
    await expect(installed.getByText('No mods on this server yet')).toBeVisible();
    // …and true on the node.
    expect(await platter.installedMods(serverId)).toEqual([]);
  });

  test('adding takes a second, deliberate act — and backing out installs nothing', async ({
    owner: page,
    platter,
  }) => {
    const review = page.getByRole('region', { name: 'Suggested for you' });
    await review.getByRole('button', { name: 'Add to server' }).click();

    // The confirmation is not "are you sure": it restates what is about to happen.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText(
      `Add ${MOD_TITLE} ${MOD_VERSION} to ${SERVER_NAME}?`,
    );
    await expect(dialog).toContainText(/downloads one file and puts it on the server/i);
    await expect(dialog).toContainText(MOD_TITLE);

    // Opening it is not consent, and neither is closing it.
    await dialog.getByRole('button', { name: 'Go back' }).click();
    await expect(dialog).toBeHidden();

    // Still open, still nothing on disk.
    await expect(review.getByText('Nothing has been added')).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'On this server' }).getByText('No mods on this server yet'),
    ).toBeVisible();
    expect(await platter.installedMods(serverId)).toEqual([]);
  });

  test('dismissing closes it, and still nothing was added', async ({ owner: page, platter }) => {
    const review = page.getByRole('region', { name: 'Suggested for you' });
    await review.getByRole('button', { name: 'Dismiss' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText(`Dismiss ${MOD_TITLE}?`);
    await expect(dialog).toContainText(/Nothing is added and nothing is deleted/i);

    await dialog.getByLabel('Why not? (optional)').fill('Client-side only on this server.');
    await dialog.getByRole('button', { name: 'Dismiss it' }).click();

    // The list empties, and says so rather than going blank.
    await expect(review.getByText('No suggestions right now')).toBeVisible();
    // The badge in the server header goes with it.
    await expect(page.getByRole('link', { name: /suggested for you/i })).toHaveCount(0);

    expect(await platter.installedMods(serverId)).toEqual([]);
  });
});

/**
 * The other half: a person who found the mod themselves.
 *
 * The defect this guards is that the browsing path used to be the review path — a required
 * "Why this mod?" box and a "Send for review" button, filing a request with yourself. There is
 * nothing to fill in here, one press does it, and the honest feedback comes after rather than
 * as a queue you then have to go and empty.
 */
test.describe('a mod a person found themselves', () => {
  let browseServerId = '';

  test.beforeAll(async ({ platter, ownerSession }) => {
    browseServerId = await platter.createPaperServer(`E2E Browse ${Date.now().toString(36)}`);
    await ownerSession.goto(`/servers/${browseServerId}/mods`);
  });

  test.afterAll(async ({ platter }) => {
    if (browseServerId) await platter.deleteServer(browseServerId);
  });

  /**
   * This one stops at the button rather than pressing it, and the reason is the fixture: the
   * stub's download URL points at Modrinth's real CDN, because the installer refuses any other
   * host (`ALLOWED_DOWNLOAD_HOSTS` in `apps/api/src/mods/install.ts`) and pointing it at
   * loopback would put the refusal under test instead of the install. The suite runs with no
   * network, so completing the download is not something this environment can do honestly.
   *
   * What the press does *after* that point is covered where it can be exercised for real:
   * `components/mods/__tests__/mod-detail-sheet.test.tsx` drives the whole add — one-press,
   * paused-for-dependencies, blocked, and the changed-download case — against a stubbed API.
   */
  test('opens a search result and offers to add it, with no form in the way', async ({
    owner: page,
    platter,
  }) => {
    const browse = page.getByRole('region', { name: 'Add a mod' });
    await browse.getByRole('searchbox').fill('lantern');
    await browse
      .getByRole('button', { name: new RegExp(MOD_TITLE) })
      .first()
      .click();

    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: MOD_TITLE })).toBeVisible();

    // The defect, named: no justification, no queue, no submission, no review.
    await expect(sheet.getByLabel(/why this mod/i)).toHaveCount(0);
    await expect(sheet.getByRole('textbox')).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /send for review/i })).toHaveCount(0);

    // One button, it says what it does, and it names the restart before it is pressed.
    const add = sheet.getByRole('button', { name: /^Add to E2E Browse/ });
    await expect(add).toBeVisible();
    await expect(sheet.getByText(/picks it up on its next restart/i)).toBeVisible();

    // And nothing is on disk, because nothing has been pressed.
    expect(await platter.installedMods(browseServerId)).toEqual([]);
  });
});
