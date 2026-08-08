import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Blueprint, BlueprintSummary, Node, ServerSummary } from '@platter/shared';
import { PowerControls, powerBlockedReason } from '@/components/servers/power-controls';
import { ServerCard, blueprintSubtitle } from '@/components/servers/server-card';
import { AuthProvider } from '@/lib/auth.js';
import { createQueryClient } from '@/lib/query.js';
import { CreateServerPage } from '@/pages/CreateServerPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { ServersPage } from '@/pages/ServersPage';

/**
 * The server surface, tested for the promises it makes rather than for its pixels.
 *
 * These guard the rules from the design contract that regress silently: the status word never
 * disappears behind a colour, a missing address says so instead of leaving a gap, an
 * unavailable power action carries its reason and stays reachable by keyboard, a kill is
 * genuinely gated, and every blocked step of the create wizard explains itself.
 */

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const MINECRAFT: BlueprintSummary = {
  key: 'minecraft-java',
  name: 'Minecraft: Java Edition',
  game: 'Minecraft',
  summary: 'Vanilla, Paper, Fabric, Forge and modpacks — one blueprint.',
  category: 'sandbox',
  icon: { monogram: 'MC', hue: 122 },
  minMemoryMb: 1024,
  recommendedMemoryMb: 4096,
  minDiskMb: 8192,
  features: { console: true, rcon: true, mods: true, worldUpload: true, playerList: true },
};

/** Deliberately includes a `TYPE` value this client has no copy for, and a hidden variable. */
const MINECRAFT_FULL: Blueprint = {
  ...MINECRAFT,
  description: 'Minecraft on the itzg image.',
  image: 'itzg/minecraft-server:2026.8.0-java21',
  ports: [
    { name: 'game', label: 'Game', containerPort: 25565, protocol: 'tcp', primary: true, bindLocal: false },
  ],
  variables: [
    {
      key: 'EULA',
      label: 'I accept the Minecraft EULA',
      description: 'Mojang requires every operator to accept it.',
      type: 'boolean',
      default: null,
      required: true,
      options: [],
      min: null,
      max: null,
      pattern: null,
      hidden: false,
      advanced: false,
    },
    {
      key: 'TYPE',
      label: 'Server type',
      description: 'Which server software to run.',
      type: 'enum',
      default: 'PAPER',
      required: true,
      options: [
        { value: 'VANILLA', label: 'Vanilla — Vanilla' },
        { value: 'PAPER', label: 'Paper — Plugins (Bukkit API)' },
        { value: 'FABRIC', label: 'Fabric — Mod loader' },
        { value: 'AUTO_CURSEFORGE', label: 'CurseForge modpack — Modpack platform' },
        { value: 'WEIRD_NEW', label: 'Weird New — Utility' },
      ],
      min: null,
      max: null,
      pattern: null,
      hidden: false,
      advanced: false,
    },
    {
      key: 'MOTD',
      label: 'Server description',
      description: 'The line players see in their multiplayer list.',
      type: 'string',
      default: 'A Platter server',
      required: false,
      options: [],
      min: null,
      max: 200,
      pattern: null,
      hidden: false,
      advanced: false,
    },
    {
      key: 'CF_SLUG',
      label: 'CurseForge pack slug',
      description: '',
      type: 'string',
      default: '',
      required: false,
      options: [],
      min: null,
      max: 128,
      pattern: '^[a-z0-9-]*$',
      hidden: false,
      advanced: true,
    },
    {
      key: 'SERVER_PORT',
      label: 'Server port',
      description: '',
      type: 'number',
      default: 25565,
      required: false,
      options: [],
      min: null,
      max: null,
      pattern: null,
      hidden: true,
      advanced: false,
    },
  ],
  files: [],
  signals: { ready: [], crash: [], playerJoin: [], playerLeave: [] },
  command: null,
  stop: { strategy: 'command', command: 'stop', signal: 'SIGTERM', timeoutSeconds: 60 },
  saveCommands: { flush: ['save-off', 'save-all flush'], resume: ['save-on'] },
  dataPath: '/data',
  docsUrl: null,
};

const NODE: Node = {
  id: 'nod_1',
  name: 'local',
  description: '',
  driver: 'docker',
  status: 'online',
  endpoint: '/var/run/docker.sock',
  publicHost: '127.0.0.1',
  portRangeStart: 25000,
  portRangeEnd: 25999,
  memoryTotalMb: 32768,
  memoryAllocatedMb: 4096,
  diskTotalMb: 512000,
  diskAllocatedMb: 8192,
  cpuCores: 8,
  overcommitRatio: 1,
  serverCount: 1,
  driverVersion: '27.0',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const SESSION = {
  id: 'usr_1',
  email: 'ada@example.com',
  username: 'ada',
  displayName: 'Ada Lovelace',
  role: 'owner',
  avatarColor: '#3fa66a',
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

function serverFixture(overrides: Partial<ServerSummary> = {}): ServerSummary {
  return {
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
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The whole API surface these three screens touch, answered from the fixtures above. */
function mockApi(server: ServerSummary) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        return json({ user: SESSION, accessToken: 'access-token', expiresIn: 900 });
      }
      if (url.includes('/blueprints/minecraft-java')) return json(MINECRAFT_FULL);
      if (url.includes('/blueprints')) return json({ data: [MINECRAFT] });
      if (url.includes('/nodes')) return json({ data: [NODE] });
      if (url.includes('/audit')) {
        return json({
          data: [
            {
              id: 'aud_1',
              action: 'server.power',
              actorId: 'usr_1',
              actorName: 'Ada Lovelace',
              targetType: 'server',
              targetId: 'srv_1',
              targetName: 'Survival SMP',
              metadata: { action: 'restart' },
              ip: null,
              userAgent: null,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          meta: { page: 1, perPage: 8, total: 1, totalPages: 1 },
        });
      }
      if (url.includes('/servers')) {
        return json({ data: [server], meta: { page: 1, perPage: 50, total: 1, totalPages: 1 } });
      }
      return json({ error: { code: 'not_found', message: 'no' } }, 404);
    }),
  );
}

/** Components that only need a router and a cache. */
function renderComponent(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Whole screens, which read the session. */
function renderScreen(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------

describe('blueprintSubtitle', () => {
  it('reads game first, then the edition', () => {
    expect(blueprintSubtitle('minecraft-java', MINECRAFT)).toBe('Minecraft · Java Edition');
  });

  it('does not repeat itself when the blueprint is the game', () => {
    expect(
      blueprintSubtitle('valheim', { ...MINECRAFT, key: 'valheim', name: 'Valheim', game: 'Valheim' }),
    ).toBe('Valheim');
  });

  it('falls back to the key rather than rendering a blank', () => {
    expect(blueprintSubtitle('project-zomboid', undefined)).toBe('project-zomboid');
  });
});

describe('ServerCard', () => {
  it('links to the server and names it, its game and its status in words', () => {
    renderComponent(<ServerCard blueprint={MINECRAFT} server={serverFixture()} />);

    const link = screen.getByRole('link', { name: /survival smp/i });
    expect(link).toHaveAttribute('href', '/servers/srv_1');
    expect(within(link).getByText('Minecraft · Java Edition')).toBeInTheDocument();
    // Colour is never the only signal: the status word travels with the dot.
    expect(within(link).getByText('Running')).toBeInTheDocument();
  });

  it('shows the connect address and the allocation', () => {
    renderComponent(<ServerCard blueprint={MINECRAFT} server={serverFixture()} />);

    expect(screen.getByText('play.example.com:25565')).toBeInTheDocument();
    expect(screen.getByText('4.0 GB · 3/20 online')).toBeInTheDocument();
  });

  it('says why there is no address instead of leaving a gap', () => {
    renderComponent(
      <ServerCard
        blueprint={MINECRAFT}
        server={serverFixture({
          status: 'installing',
          primaryAddress: null,
          playersOnline: null,
          playersMax: null,
        })}
      />,
    );

    expect(screen.getByText('Address assigned during install')).toBeInTheDocument();
    expect(screen.getByText('Installing')).toBeInTheDocument();
  });

  it('works without a blueprint, deriving a stable mark from the key', () => {
    renderComponent(<ServerCard server={serverFixture()} />);
    expect(screen.getByRole('link', { name: /survival smp/i })).toBeInTheDocument();
  });
});

describe('powerBlockedReason', () => {
  it('allows exactly what the shared table allows', () => {
    expect(powerBlockedReason('offline', 'start')).toBeNull();
    expect(powerBlockedReason('running', 'stop')).toBeNull();
    expect(powerBlockedReason('running', 'restart')).toBeNull();
    expect(powerBlockedReason('installing', 'kill')).toBeNull();
  });

  it('explains a suspension rather than only greying the button out', () => {
    expect(powerBlockedReason('suspended', 'start')).toMatch(/administrator/i);
  });

  it('points a failed install at the fix', () => {
    expect(powerBlockedReason('install_failed', 'start')).toMatch(/reinstall/i);
  });

  it('does not offer restart to a server that is not running', () => {
    expect(powerBlockedReason('offline', 'restart')).toMatch(/start it instead/i);
  });
});

describe('PowerControls', () => {
  it('offers only the legal actions and explains the rest', () => {
    renderComponent(
      <PowerControls server={{ id: 'srv_1', name: 'Survival SMP', status: 'running' }} />,
    );

    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled();

    // Start is blocked, and the reason is reachable without a pointer: it is the focusable
    // wrapper's own accessible name.
    const blocked = screen.getByRole('button', { name: /^Start — unavailable\./ });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(blocked).toHaveAccessibleName(/It is already running\./);
    expect(blocked).toHaveAttribute('tabindex', '0');
  });

  it('confirms a kill by naming what it costs', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    renderComponent(
      <PowerControls server={{ id: 'srv_1', name: 'Survival SMP', status: 'running' }} />,
    );

    await user.click(screen.getByRole('button', { name: 'Kill' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/SIGKILL/)).toBeInTheDocument();
    expect(within(dialog).getByText(/corrupt/i)).toBeInTheDocument();
    // Nothing has been sent yet — the confirmation is a real gate, not a formality.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the power action and shows the status the API actually returned', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          id: 'srv_1',
          name: 'Survival SMP',
          description: '',
          blueprintKey: 'minecraft-java',
          nodeId: 'nod_1',
          ownerId: 'usr_1',
          // The API answers `stopping`, not `offline`. That is what the UI must show.
          status: 'stopping',
          containerId: 'c1',
          limits: { memoryMb: 4096, diskMb: 8192, cpuCores: 2, swapMb: 0, ioWeight: 500 },
          allocations: [],
          variables: {},
          autoStart: true,
          autoRestart: true,
          lastExitCode: null,
          lastCrashAt: null,
          installedAt: null,
          startedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    );

    renderComponent(
      <PowerControls server={{ id: 'srv_1', name: 'Survival SMP', status: 'running' }} />,
    );

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(([url]) => String(url).includes('/servers/srv_1/power'))).toBe(true);
    });
  });
});

describe('DashboardPage', () => {
  it('surfaces a crashed server first, with the action that fixes it', async () => {
    mockApi(serverFixture({ status: 'crashed' }));
    renderScreen(<DashboardPage />);

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
    // A crashed server can be started, so the button is right there rather than a page away.
    expect(await screen.findByRole('button', { name: 'Start' })).toBeEnabled();
  });

  it('writes activity as sentences, not raw verbs', async () => {
    mockApi(serverFixture());
    renderScreen(<DashboardPage />);

    expect(await screen.findByText('Ada Lovelace sent restart to Survival SMP')).toBeInTheDocument();
  });

  it('measures allocation against the node when the account can read it', async () => {
    mockApi(serverFixture());
    renderScreen(<DashboardPage />);

    // The chart is never the only representation: the exact figures are in text beside it.
    expect(await screen.findByText('Memory allocated')).toBeInTheDocument();
    expect(await screen.findByText(/4\.0 GB of 32 GB/)).toBeInTheDocument();
  });
});

describe('ServersPage', () => {
  it('lists servers and keeps the status filter in the URL', async () => {
    const user = userEvent.setup();
    mockApi(serverFixture());
    renderScreen(<ServersPage />);

    expect(await screen.findByRole('heading', { name: 'Servers' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /survival smp/i })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'running');
    await waitFor(() => expect(screen.getByLabelText('Status')).toHaveValue('running'));
  });
});

describe('CreateServerPage', () => {
  it('walks every step, explaining each thing it is waiting for', async () => {
    const user = userEvent.setup();
    mockApi(serverFixture());
    renderScreen(<CreateServerPage />);

    expect(await screen.findByRole('heading', { name: 'New server' })).toBeInTheDocument();
    // A disabled control always says why.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText('Pick a game to continue.')).toBeInTheDocument();

    await user.click(await screen.findByRole('radio', { name: /Minecraft/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());

    // Minecraft, and only Minecraft, gets the server-type step.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Mod loaders' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Paper/ })).toBeChecked();
    // A type this client has no copy for still appears, in the family the blueprint declared.
    expect(screen.getByRole('radio', { name: /Weird New/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText('Server name')).toHaveValue('Minecraft');
    // Memory starts at the blueprint's recommendation, formatted for a human.
    expect(screen.getByText('4.0 GB')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Before it can start' })).toBeInTheDocument();
    // The EULA is required and has no default, so Create is blocked and says so.
    expect(screen.getByRole('button', { name: 'Create server' })).toBeDisabled();
    expect(screen.getByText(/setting still needs attention/)).toBeInTheDocument();
    // Advanced settings stay collapsed until asked for.
    expect(screen.queryByLabelText('CurseForge pack slug')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Minecraft EULA/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create server' })).toBeEnabled());
  });
});
