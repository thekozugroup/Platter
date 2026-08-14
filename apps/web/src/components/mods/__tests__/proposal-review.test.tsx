import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PendingProposalsBadge,
  ProposalQueue,
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
 * The half of the mod flow where the human did *not* choose.
 *
 * An agent over MCP can suggest a mod and cannot install one, so this screen is a decision put
 * to a person — and the tests are about the promises that decision rests on, not about pixels.
 * Every case guards something that would fail silently and dangerously: somebody believing an
 * agent already installed something, somebody adding a build that is not the one they read,
 * an "informed decision" screen that quietly stopped showing the licence.
 *
 * It also guards the register. This screen must read as *someone suggested this for you*, with
 * two buttons and nothing to fill in — never as a form, and never in the vocabulary of the
 * dependency resolver underneath it.
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
  // As the API sends it: `resolve.ts` fills `requiredBy` from the graph's keys, which are
  // registry project ids — never something to print at a person.
  requiredBy: ['P7dR8mSH'],
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
      { field: 'sha512', before: 'a'.repeat(16), after: 'c'.repeat(16), material: true },
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
        <ProposalReview proposal={proposal} serverId="srv_1" serverName="Survival SMP" />
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
  it('says nothing has been added, before anything else', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview();

    expect(screen.getByText('Nothing has been added')).toBeInTheDocument();
    expect(
      screen.getByText(/No file has been downloaded, nothing has been written to Survival SMP/i),
    ).toBeInTheDocument();
  });

  it('reads as a suggestion someone made, not as a form to fill in', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview();

    expect(
      screen.getByRole('heading', { name: 'An assistant suggested this for Survival SMP' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/needs Fabric API to register its blocks/i)).toBeInTheDocument();
    // Nothing to complete and nothing to submit: two buttons, and that is the whole input.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/why this mod/i)).not.toBeInTheDocument();
  });

  it('names a human proposer when there is one', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview(proposalFixture({ proposedById: 'usr_2', proposedByName: 'Ada Lovelace' }));

    expect(
      screen.getByRole('heading', { name: 'Ada Lovelace suggested this for Survival SMP' }),
    ).toBeInTheDocument();
  });
});

describe('ProposalReview — informed decision', () => {
  it('shows the full listing, not a summary', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview();

    // Who made it, its licence and how many people use it are the facts that answer
    // "is this project real?".
    expect(screen.getByText('modmuss50')).toBeInTheDocument();
    expect(screen.getByText('Apache-2.0')).toBeInTheDocument();
    expect(screen.getByText('2.4M')).toBeInTheDocument();
    // The description body itself, rendered rather than truncated to the summary line.
    expect(screen.getByText('The core library for the Fabric toolchain.')).toBeInTheDocument();
    expect(screen.getByText('Registry sync')).toBeInTheDocument();
    // And the outbound links needed for a second opinion.
    expect(screen.getByRole('link', { name: /Bug reports/ })).toHaveAttribute(
      'href',
      'https://github.com/FabricMC/fabric/issues',
    );
    // Captured, not live — the panel says which.
    expect(screen.getByText(/not a fresh read/i)).toBeInTheDocument();
  });

  it('says what it would do in plain words, with the exact files still on screen', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview();

    expect(screen.getByText('Adds Fabric API')).toBeInTheDocument();
    expect(screen.getByText('Adds 1 more mod it needs')).toBeInTheDocument();
    // Once in the sentence, once in the file list below it.
    expect(screen.getAllByText(/Fabric Language Kotlin/)).toHaveLength(2);
    // This is the security gate, so the filenames start visible here rather than folded away.
    expect(screen.getByText('mods/fabric-api-0.102.0.jar')).toBeInTheDocument();
    expect(screen.getByText('mods/fabric-language-kotlin-1.12.0.jar')).toBeInTheDocument();
    // Never the registry id the API sends, and never the resolver's vocabulary.
    expect(screen.queryByText(/P7dR8mSH/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dependency/i)).not.toBeInTheDocument();
  });

  it('refuses the add when the plan does not work, and says why', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
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

    const add = screen.getByRole('button', { name: 'Add all 2 to server' });
    expect(add).toBeDisabled();
    // A disabled control always carries its reason, and the reason is tied to the control.
    expect(add).toHaveAccessibleDescription(/no longer works on Survival SMP/i);
    expect(screen.getByText('Built for a different kind of server.')).toBeInTheDocument();
    expect(
      screen.getByText(/This build needs Fabric and the server runs Paper./),
    ).toBeInTheDocument();
  });
});

describe('ProposalReview — the decision', () => {
  it('offers add and dismiss at equal weight, with neither pre-selected', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview();

    const add = screen.getByRole('button', { name: 'Add all 2 to server' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });

    // Same variant, so neither is the near-black primary the rest of the app uses. The
    // interface has no opinion about which way this should go.
    expect(add.getAttribute('data-variant')).toBe(dismiss.getAttribute('data-variant'));
    expect(add).toHaveAttribute('data-variant', 'outline');
    expect(document.activeElement).not.toBe(add);
    expect(document.activeElement).not.toBe(dismiss);
  });

  it('adds nothing until the confirmation is answered', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview();

    await user.click(screen.getByRole('button', { name: 'Add all 2 to server' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Add Fabric API 0.102.0+1.21.1 to Survival SMP?');
    expect(within(dialog).getByText(/downloads 2 files/i)).toBeInTheDocument();
    expect(fetchCalls().some(([url]) => url.includes('/approve'))).toBe(false);
  });

  it('sends the optional note with a dismissal', async () => {
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

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(
      within(dialog).getByLabelText('Why not? (optional)'),
      'We already ship Paper, not Fabric.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss it' }));

    await waitFor(() => {
      const call = fetchCalls().find(([url]) => url.includes('/reject'));
      expect(call).toBeDefined();
      expect(String(call?.[1]?.body)).toContain('We already ship Paper, not Fabric.');
    });
  });
});

describe('ProposalReview — the listing changing underneath', () => {
  it('surfaces a changed listing prominently and adds nothing', async () => {
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

    await user.click(screen.getByRole('button', { name: 'Add all 2 to server' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add to server' }));

    const panel = await screen.findByRole('alert');
    expect(within(panel).getByText('This is not what you were shown')).toBeInTheDocument();
    expect(within(panel).getByText(/Nothing was added/)).toBeInTheDocument();
    // The difference is field-level and named in words, not in registry field names.
    expect(within(panel).getByText('The file’s fingerprint')).toBeInTheDocument();
    expect(within(panel).getByText('Where it downloads from')).toBeInTheDocument();
    expect(
      within(panel).getByText('https://elsewhere.invalid/fabric-api-0.102.0.jar'),
    ).toBeInTheDocument();
    // A cosmetic change is shown but marked as not affecting what runs.
    expect(within(panel).getByText('Does not change what runs')).toBeInTheDocument();
  });

  it('adds again only against the digest it has just shown', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/approve') ? json(changedOutcome(), 409) : json({ data: [] }),
      ),
    );
    renderReview();

    await user.click(screen.getByRole('button', { name: 'Add all 2 to server' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Add to server',
      }),
    );
    await user.click(
      await screen.findByRole('button', {
        name: 'I have read the changes — add the new one',
      }),
    );

    await waitFor(() => {
      const approvals = fetchCalls().filter(([url]) => url.includes('/approve'));
      expect(approvals).toHaveLength(2);
      // The first attempt acknowledges nothing; the second carries the digest that was
      // actually shown. That is the only way consent to the new bytes can be expressed.
      expect(String(approvals[0]?.[1]?.body)).toContain('"acknowledgedDigest":null');
      expect(String(approvals[1]?.[1]?.body)).toContain('digest-after-the-change');
    });
  });

  it('warns about a change found on an earlier attempt, before anything is pressed', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview(proposalFixture({ driftDetectedAt: '2026-08-02T09:00:00.000Z' }));

    expect(
      screen.getByText('This listing changed once since it was suggested'),
    ).toBeInTheDocument();
  });
});

describe('ProposalReview — settled suggestions', () => {
  it('reports a dismissal with its note instead of offering the decision again', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview(
      proposalFixture({
        status: 'rejected',
        reviewedByName: 'Ada Lovelace',
        reviewedAt: '2026-08-02T09:00:00.000Z',
        reviewNote: 'Wrong loader.',
      }),
    );

    expect(screen.getByText('Dismissed')).toBeInTheDocument();
    expect(screen.getByText('“Wrong loader.”')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add all/ })).not.toBeInTheDocument();
  });

  it('explains a failed add rather than leaving it looking open', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    renderReview(
      proposalFixture({ status: 'failed', error: 'The checksum did not match the download.' }),
    );

    expect(screen.getByText('Adding it failed')).toBeInTheDocument();
    expect(screen.getByText(/The checksum did not match the download./)).toBeInTheDocument();
  });
});

describe('ProposalQueue — a failed add is not allowed to vanish', () => {
  function renderQueue() {
    return render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ProposalQueue serverId="srv_1" serverName="Survival SMP" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  const FAILURE = 'Downloading fabric-api-0.102.0.jar failed (403).';

  function queueFetch(pending: ModProposal[], failed: ModProposal[]) {
    return vi.fn(async (input: RequestInfo | URL) =>
      json({ data: String(input).includes('status=failed') ? failed : pending }),
    );
  }

  it('keeps a failed suggestion on screen, with the reason, instead of an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      queueFetch(
        [],
        [
          proposalFixture({
            status: 'failed',
            reviewedAt: new Date().toISOString(),
            error: FAILURE,
          }),
        ],
      ),
    );
    renderQueue();

    // Pressing add is what put it here; "no suggestions right now" would say the opposite
    // of what happened.
    expect(await screen.findByText('Adding it failed')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(FAILURE.replace(/[.()]/g, '\\$&')))).toBeInTheDocument();
    expect(screen.queryByText('No suggestions right now')).not.toBeInTheDocument();
    // Terminal on the API, so the way forward is a fresh suggestion rather than a retry.
    expect(screen.getByRole('button', { name: 'Try it again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add all/ })).not.toBeInTheDocument();
  });

  it('drops a failure once it is a week old', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    vi.stubGlobal(
      'fetch',
      queueFetch([], [proposalFixture({ status: 'failed', reviewedAt: old, error: FAILURE })]),
    );
    renderQueue();

    expect(await screen.findByText('No suggestions right now')).toBeInTheDocument();
  });

  it('waits for both halves before claiming there is nothing waiting', async () => {
    let releaseFailed: () => void = () => undefined;
    const failedArrives = new Promise<void>((resolve) => {
      releaseFailed = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('status=failed')) {
          await failedArrives;
          return json({ data: [proposalFixture({ status: 'failed', error: FAILURE })] });
        }
        return json({ data: [] });
      }),
    );
    renderQueue();

    // The pending list is back and empty, but nothing may be claimed about the queue yet.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('No suggestions right now')).not.toBeInTheDocument();

    releaseFailed();
    expect(await screen.findByText('Adding it failed')).toBeInTheDocument();
  });
});

describe('ProposalReview — a failure recorded on an open suggestion', () => {
  it('reports the last attempt rather than showing something that looks untouched', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    // A *retryable* failure leaves the suggestion open with the reason stored on it.
    renderReview(proposalFixture({ error: 'The node did not answer in time.' }));

    expect(screen.getByText('The last attempt did not finish')).toBeInTheDocument();
    expect(screen.getByText(/The node did not answer in time./)).toBeInTheDocument();
    // Still open, so the decision is still offered.
    expect(screen.getByRole('button', { name: 'Add all 2 to server' })).toBeEnabled();
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

  it('renders nothing when nothing is waiting, so it is safe to mount always', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [] })),
    );
    const { container } = renderBadge();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('counts what is waiting and links to the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [proposalFixture(), proposalFixture({ id: 'mpr_2' })] })),
    );
    renderBadge();

    const link = await screen.findByRole('link', { name: '2 mods suggested for you' });
    expect(link).toHaveAttribute('href', '/servers/srv_1/mods');
  });
});
