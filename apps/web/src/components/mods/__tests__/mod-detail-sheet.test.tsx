import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModDetailSheet } from '@/components/mods/mod-detail-sheet';
import type {
  ApprovalOutcome,
  InstalledMod,
  ModDetail,
  ModProposal,
  ModVersion,
  PlannedInstall,
  Resolution,
} from '@/hooks';
import { createQueryClient } from '@/lib/query.js';

/**
 * The human path: search, open, add.
 *
 * The defect these tests exist to hold shut is a *wording* one with real consequences. The
 * panel used to make a person write "Why this mod?" and press "Send for review", filing a
 * request with themselves that then waited in a queue for their own approval. Nothing about
 * that is a review; it is a form standing between somebody and the thing they already decided
 * to do. So the first block asserts the absence of the form as hard as it asserts the presence
 * of the button.
 *
 * The second block is the promise that makes a one-press add safe: a plan with a surprise in
 * it — other mods coming along, something being overwritten, any problem at all — stops and
 * says so in plain words *before* a byte is downloaded, and a plan with no surprise does not
 * charge a click for the privilege of saying "one file will be added".
 */

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const MOD: ModDetail = {
  source: 'modrinth',
  projectId: 'AANobbMI',
  slug: 'sodium',
  title: 'Sodium',
  summary: 'A modern rendering engine.',
  author: 'jellysquid3',
  iconUrl: null,
  downloads: 4_100_000,
  follows: 12_000,
  categories: ['optimization'],
  loaders: ['fabric'],
  gameVersions: ['1.21.1'],
  clientSide: 'required',
  serverSide: 'optional',
  license: 'LGPL-3.0-only',
  projectType: 'mod',
  updatedAt: '2026-07-01T00:00:00.000Z',
  url: 'https://modrinth.com/mod/sodium',
  description: 'Rewrites the renderer.',
  descriptionFormat: 'markdown',
  gallery: [],
  licenseUrl: null,
  sourceUrl: null,
  issuesUrl: null,
  wikiUrl: null,
  discordUrl: null,
  donationUrls: [],
};

function versionFixture(overrides: Partial<ModVersion> = {}): ModVersion {
  return {
    source: 'modrinth',
    projectId: 'AANobbMI',
    versionId: 'ver_new',
    name: 'Sodium 0.6.0',
    versionNumber: '0.6.0',
    channel: 'release',
    gameVersions: ['1.21.1'],
    loaders: ['fabric'],
    publishedAt: '2026-07-01T00:00:00.000Z',
    downloads: 90_000,
    dependencies: [],
    file: {
      filename: 'sodium-0.6.0.jar',
      url: 'https://cdn.modrinth.com/sodium-0.6.0.jar',
      sizeBytes: 1_100_000,
      sha512: 'a'.repeat(16),
      sha1: null,
    },
    changelog: null,
    ...overrides,
  };
}

function plannedFixture(overrides: Partial<PlannedInstall> = {}): PlannedInstall {
  return {
    source: 'modrinth',
    projectId: 'AANobbMI',
    slug: 'sodium',
    title: 'Sodium',
    iconUrl: null,
    target: 'mods',
    version: versionFixture(),
    reason: 'requested',
    requiredBy: [],
    replacesVersionId: null,
    ...overrides,
  };
}

function resolutionFixture(overrides: Partial<Resolution> = {}): Resolution {
  return {
    install: [plannedFixture()],
    satisfied: [],
    problems: [],
    installable: true,
    ...overrides,
  };
}

function proposalFixture(resolution: Resolution): ModProposal {
  return {
    id: 'mpr_new',
    serverId: 'srv_1',
    status: 'pending',
    source: 'modrinth',
    projectId: 'AANobbMI',
    slug: 'sodium',
    title: 'Sodium',
    versionId: 'ver_new',
    versionNumber: '0.6.0',
    rationale: 'Chosen and added by hand from the mod browser.',
    proposedById: 'usr_1',
    proposedByName: 'Ada Lovelace',
    proposedAt: '2026-08-14T10:00:00.000Z',
    reviewedById: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    snapshot: { detail: MOD, version: versionFixture(), resolution, digest: 'digest-1' },
    driftDetectedAt: null,
    installedVersionId: null,
    error: null,
  };
}

function installedFixture(overrides: Partial<InstalledMod> = {}): InstalledMod {
  return {
    source: 'modrinth',
    projectId: 'AANobbMI',
    versionId: 'ver_old',
    slug: 'sodium',
    title: 'Sodium',
    versionNumber: '0.5.8',
    filename: 'sodium-0.5.8.jar',
    target: 'mods',
    sizeBytes: 1_000_000,
    sha512: 'b'.repeat(16),
    sha1: null,
    gameVersions: ['1.21.1'],
    loaders: ['fabric'],
    publishedAt: '2026-01-01T00:00:00.000Z',
    installedAt: '2026-02-01T00:00:00.000Z',
    installedById: 'usr_1',
    installedByName: 'Ada Lovelace',
    proposalId: null,
    ...overrides,
  };
}

function installedOutcome(resolution: Resolution): ApprovalOutcome {
  return {
    status: 'installed',
    proposal: { ...proposalFixture(resolution), status: 'approved' },
    installed: resolution.install.map((entry) =>
      installedFixture({
        projectId: entry.projectId,
        slug: entry.slug,
        title: entry.title,
        versionId: entry.version.versionId,
        versionNumber: entry.version.versionNumber,
        filename: entry.version.file.filename,
      }),
    ),
    resolution,
    changes: [],
    digest: 'digest-1',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Wiring {
  detail?: Partial<{
    compatibleVersions: ModVersion[];
    installed: InstalledMod | null;
    incompatibleReason: string | null;
  }>;
  resolution?: Resolution;
  approve?: () => Response;
}

/**
 * One fetch stub for the whole flow. The add path is three real calls — read the project,
 * work out the plan, install it — and stubbing them together is what lets a test assert the
 * order they happen in and, more importantly, that the third one has not happened yet.
 */
function wire({ detail = {}, resolution = resolutionFixture(), approve }: Wiring = {}) {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push([url, init]);
    if (url.includes('/approve')) {
      return approve ? approve() : json(installedOutcome(resolution));
    }
    if (url.includes('/reject'))
      return json({ ...proposalFixture(resolution), status: 'rejected' });
    if (url.includes('/proposals')) return json(proposalFixture(resolution), 201);
    if (url.includes('/mods/modrinth/sodium')) {
      return json({
        mod: MOD,
        compatibleVersions: [versionFixture()],
        installed: null,
        target: 'mods',
        incompatibleReason: null,
        ...detail,
      });
    }
    return json({ data: [] });
  });
  vi.stubGlobal('fetch', stub);
  return calls;
}

function renderSheet(props: Partial<React.ComponentProps<typeof ModDetailSheet>> = {}) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <ModDetailSheet
          onClose={() => undefined}
          serverId="srv_1"
          serverName="Survival SMP"
          serverRunning
          target={{ source: 'modrinth', project: 'sodium', title: 'Sodium' }}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const addButton = () => screen.findByRole('button', { name: 'Add to Survival SMP' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------

describe('ModDetailSheet — a person who already decided', () => {
  it('offers to add it, and asks for no justification', async () => {
    wire();
    renderSheet();

    expect(await addButton()).toBeInTheDocument();
    // The defect, named: a review form pointed at the person filling it in.
    expect(screen.queryByLabelText(/why this mod/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send for review/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/review queue/i)).not.toBeInTheDocument();
  });

  it('makes adding the one primary action on the panel', async () => {
    wire();
    renderSheet();

    // Near-black primary, and the only one — DESIGN §2 allows exactly one per view.
    expect(await addButton()).toHaveAttribute('data-variant', 'default');
    const primaries = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('data-variant') === 'default');
    expect(primaries).toHaveLength(1);
  });

  it('says it needs a restart before the press, not only after', async () => {
    wire();
    renderSheet();

    expect(await addButton()).toHaveAccessibleDescription(/next restart/i);
  });

  it('adds a plain one-file mod in a single press, and says what happened', async () => {
    const user = userEvent.setup();
    const calls = wire();
    renderSheet();

    await user.click(await addButton());

    expect(await screen.findByText('Added to Survival SMP')).toBeInTheDocument();
    expect(screen.getByText(/Sodium 0.6.0 is on the server/)).toBeInTheDocument();
    expect(screen.getByText(/Restart Survival SMP and it will load/)).toBeInTheDocument();
    // One press, no confirmation step: there was nothing to warn about.
    expect(calls.filter(([url]) => url.includes('/approve'))).toHaveLength(1);
  });

  it('moves focus to the answer, since the button it replaced is gone', async () => {
    const user = userEvent.setup();
    wire();
    renderSheet();

    await user.click(await addButton());

    // Pressing a control that then ceases to exist drops a keyboard user onto the body.
    const answer = await screen.findByRole('status');
    expect(answer).toHaveTextContent('Added to Survival SMP');
    await waitFor(() => expect(document.activeElement).toBe(answer));
  });

  it('tells a stopped server it will load on the next start, not on a restart', async () => {
    const user = userEvent.setup();
    wire();
    renderSheet({ serverRunning: false });

    await user.click(await addButton());

    expect(
      await screen.findByText(/It loads the next time you start Survival SMP/),
    ).toBeInTheDocument();
  });
});

describe('ModDetailSheet — surprises are named before the download', () => {
  const WITH_DEPENDENCIES = resolutionFixture({
    install: [
      plannedFixture(),
      plannedFixture({
        projectId: 'P7dR8mSH',
        slug: 'fabric-api',
        title: 'Fabric API',
        reason: 'dependency',
        requiredBy: ['AANobbMI'],
        version: versionFixture({
          versionId: 'ver_dep',
          versionNumber: '0.102.0',
          file: {
            filename: 'fabric-api-0.102.0.jar',
            url: 'https://cdn.modrinth.com/fabric-api.jar',
            sizeBytes: 2_200_000,
            sha512: 'c'.repeat(16),
            sha1: null,
          },
        }),
      }),
    ],
  });

  it('says "adds 1 more mod it needs" and waits, before anything is downloaded', async () => {
    const user = userEvent.setup();
    const calls = wire({ resolution: WITH_DEPENDENCIES });
    renderSheet();

    await user.click(await addButton());

    expect(await screen.findByText('Adds 1 more mod it needs')).toBeInTheDocument();
    expect(screen.getByText(/Fabric API/)).toBeInTheDocument();
    expect(screen.getByText('Nothing has been downloaded yet.')).toBeInTheDocument();
    // The plan was worked out. Nothing was installed.
    expect(calls.some(([url]) => url.includes('/approve'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Add all 2' }));
    expect(await screen.findByText('Added to Survival SMP')).toBeInTheDocument();
  });

  it('keeps the exact filenames one press away rather than in your face', async () => {
    const user = userEvent.setup();
    wire({ resolution: WITH_DEPENDENCIES });
    renderSheet();

    await user.click(await addButton());
    await screen.findByText('Adds 1 more mod it needs');
    expect(screen.queryByText('mods/fabric-api-0.102.0.jar')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show the exact 2 files' }));
    expect(screen.getByText('mods/fabric-api-0.102.0.jar')).toBeInTheDocument();
  });

  it('closes the staged plan when the reader backs out, so it cannot look like a suggestion', async () => {
    const user = userEvent.setup();
    const calls = wire({ resolution: WITH_DEPENDENCIES });
    renderSheet();

    await user.click(await addButton());
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      const reject = calls.find(([url]) => url.includes('/reject'));
      expect(reject).toBeDefined();
      expect(String(reject?.[1]?.body)).toContain('Nothing was added');
    });
    expect(calls.some(([url]) => url.includes('/approve'))).toBe(false);
    // And the panel is back to offering the add, not stuck in a half-finished state.
    expect(await addButton()).toBeInTheDocument();
  });

  it('says what a warning means, in words, without the resolver vocabulary', async () => {
    const user = userEvent.setup();
    wire({
      resolution: resolutionFixture({
        problems: [
          {
            kind: 'prerelease_selected',
            severity: 'warning',
            source: 'modrinth',
            projectId: 'AANobbMI',
            title: 'Sodium',
            message: 'Only a beta build of Sodium is compatible with this server (0.6.0-beta).',
          },
        ],
      }),
    });
    renderSheet();

    await user.click(await addButton());

    expect(await screen.findByText('Only a test build fits.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add it' })).toBeEnabled();
  });

  it('refuses to add a plan that does not work, and says why', async () => {
    const user = userEvent.setup();
    wire({
      resolution: resolutionFixture({
        installable: false,
        problems: [
          {
            kind: 'incompatible_with_installed',
            severity: 'error',
            source: 'modrinth',
            projectId: 'AANobbMI',
            title: 'Sodium',
            message: 'Sodium declares it cannot run alongside Optifine. Remove Optifine first.',
          },
        ],
      }),
    });
    renderSheet();

    await user.click(await addButton());

    expect(
      await screen.findByText('It clashes with a mod already on this server.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add it' })).toBeDisabled();
  });
});

describe('ModDetailSheet — honest about what is already there', () => {
  it('will not re-add the version already on the server', async () => {
    wire({
      detail: { installed: installedFixture({ versionId: 'ver_new', versionNumber: '0.6.0' }) },
    });
    renderSheet();

    const button = await screen.findByRole('button', { name: 'Already on Survival SMP' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/already on Survival SMP/i);
    expect(await screen.findByText('Already on this server')).toBeInTheDocument();
  });

  it('offers the swap when the newest version is not the one installed', async () => {
    wire({ detail: { installed: installedFixture() } });
    renderSheet();

    const button = await screen.findByRole('button', { name: 'Swap in this version' });
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleDescription(/Replaces the copy already on Survival SMP/i);
  });

  it('offers nothing to press when the server cannot run it', async () => {
    wire({
      detail: {
        compatibleVersions: [],
        incompatibleReason: 'Sodium has no build for Minecraft 1.21.1 on Fabric.',
      },
    });
    renderSheet();

    expect(await screen.findByText('This server can’t run it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add to/ })).not.toBeInTheDocument();
  });

  it('reports a registry it could not reach instead of an empty panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ error: { code: 'service_unavailable', message: 'Modrinth did not answer.' } }, 503),
      ),
    );
    renderSheet();

    // 503 is retryable, so the real client tries twice more with backoff before giving up.
    // Waiting it out is the point: nothing may appear that implies the mod could be added.
    expect(
      await screen.findByText('Couldn’t load this mod', {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add to/ })).not.toBeInTheDocument();
  }, 15000);
});

describe('ModDetailSheet — the download changing underneath', () => {
  it('stops, says what moved in plain words, and installs nothing', async () => {
    const user = userEvent.setup();
    const changed: ApprovalOutcome = {
      status: 'changed',
      proposal: proposalFixture(resolutionFixture()),
      installed: [],
      resolution: resolutionFixture(),
      changes: [
        { field: 'sha512', before: 'a'.repeat(16), after: 'z'.repeat(16), material: true },
        {
          field: 'url',
          before: 'https://cdn.modrinth.com/sodium-0.6.0.jar',
          after: 'https://elsewhere.invalid/sodium.jar',
          material: true,
        },
      ],
      digest: 'digest-2',
    };
    const calls = wire({ approve: () => json(changed, 409) });
    renderSheet();

    await user.click(await addButton());

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The download has changed')).toBeInTheDocument();
    expect(
      within(alert).getByText(/the file’s fingerprint and where it downloads from/),
    ).toBeInTheDocument();

    // Going ahead is a second, separate act, and it carries the digest just shown.
    await user.click(within(alert).getByRole('button', { name: 'Add the new one anyway' }));
    await waitFor(() => {
      const approvals = calls.filter(([url]) => url.includes('/approve'));
      expect(approvals).toHaveLength(2);
      expect(String(approvals[0]?.[1]?.body)).toContain('"acknowledgedDigest":null');
      expect(String(approvals[1]?.[1]?.body)).toContain('digest-2');
    });
  });
});

describe('ModDetailSheet — the listing itself', () => {
  it('answers "does everyone joining need this too?" in a sentence', async () => {
    wire();
    renderSheet();

    // `clientSide: 'required'` used to render as the words "Client side: required".
    expect(await screen.findByText(/Everyone joining has to install it too/)).toBeInTheDocument();
    expect(screen.queryByText(/Client side:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Server side:/)).not.toBeInTheDocument();
  });

  it('keeps the facts that decide whether a project is real', async () => {
    wire();
    renderSheet();

    expect(await screen.findByText('jellysquid3')).toBeInTheDocument();
    expect(screen.getByText('LGPL-3.0-only')).toBeInTheDocument();
    expect(screen.getByText('4.1M')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open it on Modrinth/ })).toHaveAttribute(
      'href',
      'https://modrinth.com/mod/sodium',
    );
  });
});
