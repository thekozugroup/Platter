import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@platter/shared';
import { CopyField } from '@/components/common/copy-field';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { GameIcon } from '@/components/common/game-icon';
import { StatusPill } from '@/components/common/status-pill';
import { ApiError } from '@/lib/api-client.js';
import { AuthProvider, useAuth } from '@/lib/auth.js';
import { createQueryClient } from '@/lib/query.js';
import { routes } from '@/routes.js';
import { AdvancedModeProvider } from '@/lib/advanced-mode.js';
import { ThemeProvider } from '@/lib/theme.js';

/**
 * The shell's load-bearing behaviour, not its pixels.
 *
 * The one thing worth the most coverage is the silent refresh: everything else in the app
 * assumes `status` is honest, and a regression there either flashes the login screen on
 * every reload or leaves a signed-out person staring at a splash forever.
 */

const SESSION_USER: SessionUser = {
  id: 'usr_test1',
  email: 'ada@example.com',
  username: 'ada',
  displayName: 'Ada Lovelace',
  role: 'owner',
  avatarColor: '#3fa66a',
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** `navigator.clipboard` is a getter-only property in jsdom, so it has to be redefined. */
function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
    writable: true,
  });
  return writeText;
}

/**
 * Every provider the real app mounts, in the real order.
 *
 * One definition rather than four copies: this stack was duplicated inline at each render
 * site, so adding a provider to the app broke three tests that each had to be found and
 * edited by hand. A test that has to be updated for a change it does not care about is a
 * test that will eventually be updated wrongly.
 */
function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AdvancedModeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      </AdvancedModeProvider>
    </ThemeProvider>
  );
}

function Harness({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <MemoryRouter>{children}</MemoryRouter>
    </Providers>
  );
}

function AuthProbe() {
  const { status, user } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.displayName ?? 'none'}</span>
    </div>
  );
}

/*
 * Ark's ScrollArea (inside the sidebar) observes its viewport. jsdom ships no
 * IntersectionObserver, and without this the shell tests pass but leak an uncaught
 * exception per render. `src/test/setup.ts` already does the same for ResizeObserver.
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthProvider silent refresh', () => {
  it('starts in loading and resolves to authenticated when the refresh cookie is good', async () => {
    mockFetch((url) => {
      if (url.includes('/auth/refresh')) {
        return json({ user: SESSION_USER, accessToken: 'access-token', expiresIn: 900 });
      }
      return json({ error: { code: 'not_found', message: 'no' } }, 404);
    });

    render(
      <Harness>
        <AuthProbe />
      </Harness>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('Ada Lovelace');
  });

  it('resolves to anonymous — never stuck on loading — when there is no cookie', async () => {
    mockFetch(() =>
      json({ error: { code: 'token_expired', message: 'You are not signed in.' } }, 401),
    );

    render(
      <Harness>
        <AuthProbe />
      </Harness>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  });

  it('refreshes exactly once even though StrictMode mounts the effect twice', async () => {
    const spy = mockFetch(() =>
      json({ user: SESSION_USER, accessToken: 'access-token', expiresIn: 900 }),
    );

    const { StrictMode } = await import('react');
    render(
      <StrictMode>
        <Harness>
          <AuthProbe />
        </Harness>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    const refreshCalls = spy.mock.calls.filter(([url]) => String(url).includes('/auth/refresh'));
    // Refresh tokens rotate: a second call would spend a token that is already gone.
    expect(refreshCalls).toHaveLength(1);
  });
});

describe('StatusPill', () => {
  it('always carries a word, so colour is never the only signal', () => {
    render(<StatusPill status="running" />);
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('names every server status it is given', () => {
    const { rerender } = render(<StatusPill status="install_failed" />);
    expect(screen.getByText('Install failed')).toBeInTheDocument();

    rerender(<StatusPill status="crashed" />);
    expect(screen.getByText('Crashed')).toBeInTheDocument();
  });

  it('announces politely when asked to', () => {
    render(<StatusPill live status="starting" />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(within(region).getByText('Starting')).toBeInTheDocument();
  });
});

describe('GameIcon', () => {
  it('is decorative unless it is given a label', () => {
    const { container, rerender } = render(<GameIcon blueprintKey="minecraft-java" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');

    rerender(<GameIcon blueprintKey="minecraft-java" label="Minecraft" />);
    expect(screen.getByRole('img', { name: 'Minecraft' })).toBeInTheDocument();
  });

  it('derives a stable monogram from the blueprint key', () => {
    render(<GameIcon blueprintKey="minecraft-java" label="Minecraft" size="md" />);
    expect(screen.getByRole('img', { name: 'Minecraft' })).toHaveTextContent('MJ');
  });
});

describe('CopyField', () => {
  it('copies the value and confirms it in a live region', async () => {
    // `userEvent.setup()` installs its own clipboard stub, so ours has to go on afterwards.
    const user = userEvent.setup();
    const writeText = stubClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyField label="Server address" value="play.example.com:25565" />);

    await user.click(screen.getByRole('button', { name: /copy server address/i }));

    expect(writeText).toHaveBeenCalledWith('play.example.com:25565');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Server address copied'),
    );
  });

  it('says so, visibly, when the clipboard refuses', async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    // The legacy path is the fallback; jsdom has no execCommand, so it throws and we report.
    render(<CopyField label="Server address" value="play.example.com:25565" />);

    await user.click(screen.getByRole('button', { name: /copy server address/i }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/couldn’t reach the clipboard/i),
    );
  });
});

describe('EmptyState', () => {
  it('offers the primary action as a real link', () => {
    render(
      <MemoryRouter>
        <EmptyState
          action={{ label: 'Create a server', to: '/servers/new' }}
          description="Servers you create appear here."
          title="No servers yet"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Create a server' })).toHaveAttribute(
      'href',
      '/servers/new',
    );
  });

  it('always shows why a disabled action is disabled', () => {
    render(
      <MemoryRouter>
        <EmptyState
          action={{ label: 'Create a server', disabledReason: 'No node is online.' }}
          description="Servers you create appear here."
          title="No servers yet"
        />
      </MemoryRouter>,
    );

    const button = screen.getByRole('button', { name: 'Create a server' });
    expect(button).toBeDisabled();
    expect(screen.getByText('No node is online.')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-describedby');
  });
});

describe('ErrorState', () => {
  it('offers retry for a retryable failure and explains what to check', () => {
    const onRetry = vi.fn();
    render(
      <MemoryRouter>
        <ErrorState
          error={
            new ApiError({
              code: 'node_unreachable',
              message: 'The host node is not responding.',
              status: 502,
            })
          }
          onRetry={onRetry}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByText(/docker socket/i)).toBeInTheDocument();
  });

  it('does not offer retry for a failure that retrying cannot fix', () => {
    render(
      <MemoryRouter>
        <ErrorState
          error={
            new ApiError({ code: 'forbidden', message: "You don't have access.", status: 403 })
          }
          onRetry={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByText(/ask an administrator/i)).toBeInTheDocument();
  });
});

describe('routing', () => {
  it('renders the not-found screen for an unrouted address', async () => {
    const { NotFoundPage } = await import('@/pages/NotFoundPage.js');

    render(
      <MemoryRouter initialEntries={['/nope']}>
        <Routes>
          <Route element={<NotFoundPage />} path="*" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /no page here/i })).toBeInTheDocument();
    expect(screen.getByText('/nope')).toBeInTheDocument();
  });

  it('sends an anonymous visitor to the login screen and keeps their destination', async () => {
    mockFetch((url) => {
      if (url.includes('/auth/refresh')) {
        return json({ error: { code: 'token_expired', message: 'Not signed in.' } }, 401);
      }
      if (url.includes('/system/info')) {
        return json({
          version: '0.1.0',
          uptimeSeconds: 1,
          needsSetup: false,
          counts: { users: 1, servers: 0, nodes: 1 },
          features: { ai: false, metrics: true, registrationEnabled: false },
        });
      }
      return json({ error: { code: 'not_found', message: 'no' } }, 404);
    });

    const router = createMemoryRouter(routes, { initialEntries: ['/servers/srv_1/files'] });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument(),
    );
    expect(router.state.location.search).toContain(encodeURIComponent('/servers/srv_1/files'));
  });
});

describe('AppShell', () => {
  function renderShell(initialEntry: string) {
    mockFetch((url) => {
      if (url.includes('/auth/refresh')) {
        return json({ user: SESSION_USER, accessToken: 'access-token', expiresIn: 900 });
      }
      if (url.includes('/servers')) {
        return json({
          data: [
            {
              id: 'srv_1',
              name: 'Survival SMP',
              blueprintKey: 'minecraft-java',
              status: 'running',
              nodeId: 'nod_1',
              primaryAddress: 'play.example.com:25565',
              memoryMb: 4096,
              cpuCores: 2,
              playersOnline: 3,
              playersMax: 20,
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          meta: { page: 1, perPage: 50, total: 1, totalPages: 1 },
        });
      }
      return json({ error: { code: 'not_found', message: 'no' } }, 404);
    });

    const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
    return render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
  }

  it('puts the skip link first and lists the servers it polls for', async () => {
    renderShell('/');

    const skip = await screen.findByRole('link', { name: /skip to content/i });
    expect(skip).toHaveAttribute('href', '#main-content');

    expect(await screen.findByRole('link', { name: /survival smp/i })).toBeInTheDocument();
    // The status word travels with the dot; colour is never the only signal.
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
  });

  it('opens the command palette on the keyboard shortcut', async () => {
    const user = userEvent.setup();
    renderShell('/');

    await screen.findByRole('link', { name: /skip to content/i });
    await user.keyboard('{Control>}k{/Control}');

    const search = await screen.findByRole('combobox', { name: /search servers and pages/i });
    expect(search).toBeInTheDocument();
  });

  it('opens the account menu with a real link to the profile screen', async () => {
    const user = userEvent.setup();
    renderShell('/');

    await screen.findByRole('link', { name: /skip to content/i });
    await user.click(screen.getByRole('button', { name: /account: ada lovelace/i }));

    const profile = await screen.findByRole('menuitem', { name: /profile and security/i });
    expect(profile).toHaveAttribute('href', '/account');
  });

  it('explains, rather than redirects, when a member opens an admin route', async () => {
    mockFetch((url) => {
      if (url.includes('/auth/refresh')) {
        return json({
          user: { ...SESSION_USER, role: 'member' },
          accessToken: 'access-token',
          expiresIn: 900,
        });
      }
      return json({ data: [], meta: { page: 1, perPage: 50, total: 0, totalPages: 0 } });
    });

    const router = createMemoryRouter(routes, { initialEntries: ['/admin/users'] });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    expect(await screen.findByText(/don’t have access to this/i)).toBeInTheDocument();
    // Still on the address they asked for: no redirect loop to debug from the outside.
    expect(router.state.location.pathname).toBe('/admin/users');
  });
});
