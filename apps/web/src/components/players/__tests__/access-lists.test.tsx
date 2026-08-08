import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessLists } from '@/components/players/access-lists';
import { blockedReasonFor } from '@/components/players/player-actions';
import { createQueryClient } from '@/lib/query.js';

/**
 * The access lists, tested for the two things that made journey 5 — "add a friend to the
 * whitelist" — unachievable rather than merely blocked.
 *
 * 1. **Honesty.** Every write here is an RCON command (`apps/api/src/services/players.ts`),
 *    so a stopped server cannot be edited. The screen used to say the opposite in three
 *    places while the button beside the copy was disabled for exactly that reason.
 * 2. **Saying it once.** The blocked reason is a two-sentence paragraph. Printed under every
 *    disabled control it appeared six times on one viewport.
 */

const OFFLINE_REASON = blockedReasonFor('offline') as string;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderLists(blockedReason: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/bans')
        ? json({ players: [], ips: [], live: false })
        : json({ enabled: false, names: [], live: false }),
    ),
  );

  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AccessLists
        blockedReason={blockedReason}
        blockedTitle={blockedReason === null ? null : 'The server is not running'}
        players={[]}
        serverId="srv_1"
        serverName="Survival SMP"
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AccessLists — what it promises', () => {
  it('never claims a name can be added while the server is down', async () => {
    renderLists(OFFLINE_REASON);
    await screen.findByText('Nobody is whitelisted yet');

    expect(screen.queryByText(/before the server is even running/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ahead of a session/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/written when it next starts/i)).not.toBeInTheDocument();
    // And it names the real mechanism instead.
    expect(
      screen.getByText(/Every change here is a console command Platter sends/i),
    ).toBeInTheDocument();
  });

  it('states why nothing can be changed once, not once per control', async () => {
    renderLists(OFFLINE_REASON);
    await screen.findByText('Nobody is whitelisted yet');

    expect(screen.getByText('These lists cannot be changed right now')).toBeInTheDocument();
    // The reason is visible exactly once inside this component; everywhere else it is a
    // tooltip and a screen-reader description on the control it disables.
    const visible = screen
      .queryAllByText(/The server is not running/i)
      .filter((node) => !node.classList.contains('sr-only'));
    expect(visible).toHaveLength(1);
  });

  it('still ties the reason to every control it disables', async () => {
    renderLists(OFFLINE_REASON);
    await screen.findByText('Nobody is whitelisted yet');

    for (const label of ['Add', 'Grant', 'Ban address']) {
      const button = screen.getByRole('button', { name: label });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(OFFLINE_REASON);
    }
  });

  it('shows no banner at all when the server is answering', async () => {
    renderLists(null);
    await screen.findByText('Nobody is whitelisted yet');

    expect(
      screen.queryByText('These lists cannot be changed right now'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled(); // empty field, not blocked
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAccessibleDescription(
      'Type a name first.',
    );
  });
});
