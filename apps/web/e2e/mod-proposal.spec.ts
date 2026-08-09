import { expect, test } from './support/fixtures';

/**
 * "The agent can propose a mod. It cannot install one."
 *
 * That sentence is the security claim on the front of the README, and this is the spec that
 * has to be able to fail if it stops being true. So the shape of the test mirrors the shape
 * of the claim:
 *
 *   - the proposal is raised the way an agent raises one — `POST /servers/:id/proposals`,
 *     the only entry point the MCP module has;
 *   - everything after that is what a *person* sees and does in the browser;
 *   - and the question asked between every step is the same one, asked of the server rather
 *     than of the screen: **is anything on disk yet?**
 *
 * The registry behind it is a fake Modrinth on loopback (`support/modrinth-stub.mjs`), so
 * the run needs no network. The resolver, the snapshot, the digest and the review panel are
 * all the real ones.
 *
 * Serial: three acts about one proposal, and the third disposes of it.
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

  test('renders the whole mod, and says plainly that nothing has been installed', async ({
    owner: page,
    platter,
  }) => {
    /*
     * Scoped to the review section rather than the page. The registry browser lower down
     * shows the same project as a search result, so an unscoped `getByText('e2e-fixtures')`
     * matches both — and would keep passing if the review panel stopped rendering the author
     * entirely, which is exactly the regression this line exists to catch.
     */
    const review = page.getByRole('region', { name: 'Waiting for review' });
    await expect(review).toBeVisible();

    // The first thing on the panel, before anything else, is the standing statement.
    await expect(review.getByText('Nothing has been installed')).toBeVisible();
    await expect(
      review.getByText(/No file has been downloaded, nothing has been written to the server/i),
    ).toBeVisible();

    // Who asked, and why. A reviewer with no reason cannot review anything.
    await expect(review.getByText(RATIONALE)).toBeVisible();

    // Exactly what would be written, named down to the directory and the file.
    await expect(
      review.getByRole('heading', { name: 'What approving would install' }),
    ).toBeVisible();
    await expect(review.getByText(MOD_FILE)).toBeVisible();

    // The mod itself — not a summary of it. A reviewer who has to open Modrinth to judge
    // whether a project is real is a reviewer who stops bothering, and that is how a
    // security gate quietly stops working.
    await expect(review.getByText(MOD_TITLE).first()).toBeVisible();
    await expect(review.getByText('e2e-fixtures', { exact: true })).toBeVisible();
    await expect(review.getByText('MIT License')).toBeVisible();
    await expect(review.getByText(/keep hostile mobs from spawning/i)).toBeVisible();
    // Which loaders it is for, so "will this even run here" is answerable on the page.
    await expect(review.getByText('paper', { exact: true }).first()).toBeVisible();

    // No shortcut anywhere on the screen. Approve and Reject, and nothing that installs.
    await expect(page.getByRole('button', { name: /^Install\b/ })).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Approve and install' })).toBeVisible();
    await expect(review.getByRole('button', { name: 'Reject' })).toBeVisible();

    // Said on the screen…
    const installed = page.getByRole('region', { name: 'Installed' });
    await expect(installed.getByText('No mods installed by Platter')).toBeVisible();
    // …and true on the node.
    expect(await platter.installedMods(serverId)).toEqual([]);
  });

  test('approving takes a second, deliberate act — and backing out installs nothing', async ({
    owner: page,
    platter,
  }) => {
    const review = page.getByRole('region', { name: 'Waiting for review' });
    await review.getByRole('button', { name: 'Approve and install' }).click();

    // The confirmation is not "are you sure": it restates what is about to be executed.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText(`Install ${MOD_TITLE} ${MOD_VERSION}?`);
    await expect(dialog).toContainText(/downloads and writes executable code/i);
    await expect(dialog).toContainText(MOD_FILE);

    // Opening it is not consent, and neither is closing it.
    await dialog.getByRole('button', { name: 'Go back' }).click();
    await expect(dialog).toBeHidden();

    // Still pending, still nothing on disk.
    await expect(review.getByText('Nothing has been installed')).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Installed' }).getByText('No mods installed by Platter'),
    ).toBeVisible();
    expect(await platter.installedMods(serverId)).toEqual([]);
  });

  test('rejecting closes it, and still nothing was installed', async ({
    owner: page,
    platter,
  }) => {
    const review = page.getByRole('region', { name: 'Waiting for review' });
    await review.getByRole('button', { name: 'Reject' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText(`Reject ${MOD_TITLE}?`);
    await expect(dialog).toContainText(/Nothing is installed and nothing is deleted/i);

    await dialog.getByLabel('Note (optional)').fill('Client-side only on this server.');
    await dialog.getByRole('button', { name: 'Reject proposal' }).click();

    // The queue empties, and says so rather than going blank.
    await expect(review.getByText('Nothing waiting for review')).toBeVisible();
    // The badge in the server header goes with it.
    await expect(page.getByRole('link', { name: /waits? for review/i })).toHaveCount(0);

    expect(await platter.installedMods(serverId)).toEqual([]);
  });
});
