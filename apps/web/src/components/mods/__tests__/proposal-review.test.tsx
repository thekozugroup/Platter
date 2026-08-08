import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PendingProposalsBadge,
  ProposalReview,
} from '@/components/mods/proposal-review';
import type {
  ApprovalOutcome,
  ModDetail,
  ModProposal,
  ModVersion,
  PlannedInstall,
  Resolution,
} from '@/hooks';
import { createQueryClient } from '@/lib/query.js';

/**
 * The approval gate, tested for the promises it makes rather than its pixels.
 *
 * Every case here guards something that would fail silently and dangerously: a reviewer
 * believing an agent already installed something, a reviewer approving a build that is not the
 * one they read, an "informed decision" screen that quietly stopped showing the licence.
 */

/*
 * Ark's ScrollArea (inside the confirmation dialogs) observes its viewport. jsdom ships no
 * IntersectionObserver, and without this the tests pass but leak an uncaught exception.
 * `src/test/setup.ts` already does the same for ResizeObserver.
 */
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    disconnect() {}
    observe() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    unobserve() {}
  } as unknown as typeof IntersectionObserver;
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const DETAIL: ModDetail = {
  source: 'modrinth',
  projectId: 'P7dR8mSH',
  slug: 'fabric-api',
  title: 'Fabric API',
  summary: 'Essential hooks for modding with Fabric.',
  author: 'modmuss50',
  iconUrl: null,
  downloads: 2_400_000,
  follows: 9100,
  categories: ['library', 'utility'],
  loaders: ['fabric'],
  gameVersions: ['1.21', '1.21.1'],
  clientSide: 'required',
  serverSide: 'required',
  license: 'Apache-2.0',
  projectType: 'mod',
  updatedAt: '2026-07-01T00:00:00.000Z',
  url: 'https://modrinth.com/mod/fabric-api',
  description:
    '# Fabric API\n\nThe core library for the Fabric toolchain.\n\n- Registry sync\n- Networking\n\nSee the [docs](https://fabricmc.net) for details.',
  descriptionFormat: 'markdown',
  gallery: [],
  licenseUrl: 'https://example.invalid/licence',
  sourceUrl: 'https://github.com/FabricMC/fabric',
  issuesUrl: 'https://github.com/FabricMC/fabric/issues',
  wikiUrl: null,
  discordUrl: null,
  donationUrls: [],
};

function versionFixture(overrides: Partial<ModVersion> = {}): ModVersion {
  return {
    source: 'modrinth',
    projectId: 'P7dR8mSH',
    versionId: 'ver_abc',
    name: 'Fabric API 0.102.0',
    versionNumber: '0.102.0+1.21.1',
    channel: 'release',
    gameVersions: ['1.21.1'],
    loaders: ['fabric'],
    publishedAt: '2026-07-01T00:00:00.000Z',
    downloads: 12_000,
    dependencies: [],
    file: {
      filename: 'fabric-api-0.102.0.jar',
      url: 'https://cdn.modrinth.com/fabric-api-0.102.0.jar',
      sizeBytes: 2_200_000,
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
    projectId: 'P7dR8mSH',
    slug: 'fabric-api',
    title: 'Fabric API',
    iconUrl: null,
    target: 'mods',
    version: versionFixture(),
    reason: 'requested',
    requiredBy: [],
    replacesVersionId: null,
    ...overrides,
  };
}

const DEPENDENCY: PlannedInstall = plannedFixture({
  projectId: 'Ha28R6CL',
  slug: 'fabric-language-kotlin',
  title: 'Fabric Language Kotlin',
  reason: 'dependency',
  requiredBy: ['Fabric API'],
  version: versionFixture({
    versionId: 'ver_dep',
    versionNumber: '1.12.0',
    file: {
      filename: 'fabric-language-kotlin-1.12.0.jar',
      url: 'https://cdn.modrinth.com/flk.jar',
      sizeBytes: 5_100_000,
      sha512: 'b'.repeat(16),
      sha1: null,
    },
  }),
});

function resolutionFixture(overrides: Partial<Resolution> = {}): Resolution {
  return {
    install: [plannedFixture(), DEPENDENCY],
    satisfied: [],
    problems: [],
    installable: true,
    ...overrides,
  };
}

function proposalFixture(overrides: Partial<ModProposal> = {}): ModProposal {
  return {
    id: 'mpr_1',
    serverId: 'srv_1',
    status: 'pending',
    source: 'modrinth',
    projectId: 'P7dR8mSH',
    slug: 'fabric-api',
    title: 'Fabric API',
    versionId: 'ver_abc',
    versionNumber: '0.102.0+1.21.1',
    rationale: 'The datapack you asked about needs Fabric API to register its blocks.',
    proposedById: null,
    proposedByName: null,
    proposedAt: '2026-08-01T10:00:00.000Z',
    reviewedById: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    snapshot: {
      detail: DETAIL,
      version: versionFixture(),
      resolution: resolutionFixture(),
      digest: 'digest-as-reviewed',
    },
    driftDetectedAt: null,
    installedVersionId: null,
    error: null,
    ...overrides,
  };
}

function changedOutcome(): ApprovalOutcome {
  return {
    status: 'changed',
    proposal: proposalFixture({ driftDetectedAt: '2026-08-02T09:00:00.000Z' }),
    installed: [],
    resolution: resolutionFixture(),
    changes: [
      {
        field: 'sha512',
        before: 'a'.repeat(16),
        after: 'c'.repeat(16),
        material: true,
      },
      {
        field: 'url',
        before: 'https://cdn.modrinth.com/fabric-api-0.102.0.jar',
        after: 'https://elsewhere.invalid/fabric-api-0.102.0.jar',
        material: true,
      },
      { field: 'summary', before: 'Essential hooks.', after: 'Now with extras.', material: false },
    ],
    digest: 'digest-after-the-change',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderReview(proposal: ModProposal = proposalFixture()) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <ProposalReview proposal={proposal} serverId="srv_1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fetchCalls(): Array<[string, RequestInit | undefined]> {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls.map(([url, init]) => [String(url), init as RequestInit | undefined]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------

describe('ProposalReview — the boundary', () => {
  it('says nothing has been installed, before anything else', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview();

    expect(screen.getByText('Nothing has been installed')).toBeInTheDocument();
    expect(
      screen.getByText(/No file has been downloaded, nothing has been written to the server/i),
    ).toBeInTheDocument();
  });

  it('names a machine credential as one rather than leaving the proposer blank', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview();

    expect(screen.getByText('An API key with the ai.use permission')).toBeInTheDocument();
    expect(
      screen.getByText(/came from a machine credential over MCP/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/needs Fabric API to register its blocks/i),
    ).toBeInTheDocument();
  });

  it('names a human proposer when there is one', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview(proposalFixture({ proposedById: 'usr_2', proposedByName: 'Ada Lovelace' }));

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });
});

describe('ProposalReview — informed decision', () => {
  it('shows the full snapshot, not a summary', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview();

    // Author, licence and downloads are the fields that decide "is this project real?".
    expect(screen.getByText('modmuss50')).toBeInTheDocument();
    expect(screen.getByText('Apache-2.0')).toBeInTheDocument();
    expect(screen.getByText('2.4M')).toBeInTheDocument();
    // The description body itself, rendered rather than truncated to the summary line.
    expect(screen.getByText('The core library for the Fabric toolchain.')).toBeInTheDocument();
    expect(screen.getByText('Registry sync')).toBeInTheDocument();
    // And the outbound links a reviewer needs for a second opinion.
    expect(screen.getByRole('link', { name: /Issue tracker/ })).toHaveAttribute(
      'href',
      'https://github.com/FabricMC/fabric/issues',
    );
    // Captured, not live — the panel says which.
    expect(screen.getByText(/when the proposal was raised/i)).toBeInTheDocument();
  });

  it('spells out every file approving would write, dependencies included', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview();

    expect(screen.getByText('mods/fabric-api-0.102.0.jar')).toBeInTheDocument();
    expect(screen.getByText('mods/fabric-language-kotlin-1.12.0.jar')).toBeInTheDocument();
    expect(screen.getByText('Pulled in as a dependency')).toBeInTheDocument();
    expect(screen.getByText('Required by Fabric API')).toBeInTheDocument();
  });

  it('disables approval when the plan does not resolve, and says why', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview(
      proposalFixture({
        snapshot: {
          detail: DETAIL,
          version: versionFixture(),
          digest: 'digest-as-reviewed',
          resolution: resolutionFixture({
            installable: false,
            problems: [
              {
                kind: 'wrong_loader',
                severity: 'error',
                source: 'modrinth',
                projectId: 'P7dR8mSH',
                title: 'Fabric API',
                message: 'This build needs Fabric and the server runs Paper.',
              },
            ],
          }),
        },
      }),
    );

    const approve = screen.getByRole('button', { name: 'Approve and install' });
    expect(approve).toBeDisabled();
    // A disabled control always carries its reason, and the reason is tied to the control.
    expect(approve).toHaveAccessibleDescription(/does not resolve against this server/i);
    expect(
      screen.getByText(/This build needs Fabric and the server runs Paper./),
    ).toBeInTheDocument();
  });
});

describe('ProposalReview — the decision', () => {
  it('offers approve and reject at equal weight, with neither pre-selected', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview();

    const approve = screen.getByRole('button', { name: 'Approve and install' });
    const reject = screen.getByRole('button', { name: 'Reject' });

    // Same variant, so neither is the near-black primary the rest of the app uses.
    expect(approve.getAttribute('data-variant')).toBe(reject.getAttribute('data-variant'));
    expect(approve).toHaveAttribute('data-variant', 'outline');
    expect(document.activeElement).not.toBe(approve);
    expect(document.activeElement).not.toBe(reject);
  });

  it('installs nothing until the confirmation is answered', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(async () => json({ data: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    renderReview();

    await user.click(screen.getByRole('button', { name: 'Approve and install' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/writes executable code/i)).toBeInTheDocument();
    expect(
      fetchCalls().some(([url]) => url.includes('/approve')),
    ).toBe(false);
  });

  it('sends the optional note with a rejection', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/reject')
          ? json(proposalFixture({ status: 'rejected' }))
          : json({ data: [] }),
      ),
    );
    renderReview();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(
      within(dialog).getByLabelText('Note (optional)'),
      'We already ship Paper, not Fabric.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject proposal' }));

    await waitFor(() => {
      const call = fetchCalls().find(([url]) => url.includes('/reject'));
      expect(call).toBeDefined();
      expect(String(call?.[1]?.body)).toContain('We already ship Paper, not Fabric.');
    });
  });
});

describe('ProposalReview — drift', () => {
  it('surfaces a changed listing prominently and installs nothing', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/approve')
          ? // The API answers 409 with the outcome body, not an error envelope.
            json(changedOutcome(), 409)
          : json({ data: [] }),
      ),
    );
    renderReview();

    await user.click(screen.getByRole('button', { name: 'Approve and install' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve and install' }));

    const panel = await screen.findByRole('alert');
    expect(within(panel).getByText('This is not what you reviewed')).toBeInTheDocument();
    expect(within(panel).getByText(/Nothing was installed/)).toBeInTheDocument();
    // The diff is field-level and names what changed, in a reviewer's vocabulary.
    expect(within(panel).getByText('SHA-512 checksum')).toBeInTheDocument();
    expect(within(panel).getByText('Download URL')).toBeInTheDocument();
    expect(
      within(panel).getByText('https://elsewhere.invalid/fabric-api-0.102.0.jar'),
    ).toBeInTheDocument();
    // A cosmetic change is shown but marked as not affecting what runs.
    expect(within(panel).getByText('Does not change what runs')).toBeInTheDocument();
  });

  it('re-approves only against the new digest', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/approve')
          ? json(changedOutcome(), 409)
          : json({ data: [] }),
      ),
    );
    renderReview();

    await user.click(screen.getByRole('button', { name: 'Approve and install' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Approve and install',
      }),
    );
    await user.click(
      await screen.findByRole('button', {
        name: 'I have read the changes — install the new version',
      }),
    );

    await waitFor(() => {
      const approvals = fetchCalls().filter(([url]) => url.includes('/approve'));
      expect(approvals).toHaveLength(2);
      // The first attempt acknowledges nothing; the second carries the digest the reviewer
      // was actually shown. That is the only way consent to the new bytes can be expressed.
      expect(String(approvals[0]?.[1]?.body)).toContain('"acknowledgedDigest":null');
      expect(String(approvals[1]?.[1]?.body)).toContain('digest-after-the-change');
    });
  });

  it('warns about drift found on an earlier attempt, before anything is pressed', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview(proposalFixture({ driftDetectedAt: '2026-08-02T09:00:00.000Z' }));

    expect(
      screen.getByText('This listing changed once since it was proposed'),
    ).toBeInTheDocument();
  });
});

describe('ProposalReview — settled proposals', () => {
  it('reports a rejection with its note instead of offering the decision again', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview(
      proposalFixture({
        status: 'rejected',
        reviewedByName: 'Ada Lovelace',
        reviewedAt: '2026-08-02T09:00:00.000Z',
        reviewNote: 'Wrong loader.',
      }),
    );

    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('“Wrong loader.”')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve and install' }),
    ).not.toBeInTheDocument();
  });

  it('explains a failed install rather than leaving it looking pending', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    renderReview(
      proposalFixture({ status: 'failed', error: 'The checksum did not match the download.' }),
    );

    expect(screen.getByText('The install failed')).toBeInTheDocument();
    expect(
      screen.getByText(/The checksum did not match the download./),
    ).toBeInTheDocument();
  });
});

describe('PendingProposalsBadge', () => {
  function renderBadge() {
    return render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <PendingProposalsBadge serverId="srv_1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('renders nothing when the queue is empty, so it is safe to mount always', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    const { container } = renderBadge();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('counts what is waiting and links to the queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [proposalFixture(), proposalFixture({ id: 'mpr_2' })] })),
    );
    renderBadge();

    const link = await screen.findByRole('link', { name: '2 mods wait for review' });
    expect(link).toHaveAttribute('href', '/servers/srv_1/mods');
  });
});
