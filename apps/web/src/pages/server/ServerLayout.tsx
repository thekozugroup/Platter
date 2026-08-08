import { createContext, useContext, useMemo } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import type { Blueprint, Server, ServerStatus } from '@platter/shared';
import { formatAddress } from '@platter/shared';
import { ArrowLeft } from 'pixelarticons/react/ArrowLeft.js';
import { CopyField } from '@/components/common/copy-field';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { GameIcon } from '@/components/common/game-icon';
import { SERVER_STATUS_HINTS, StatusPill } from '@/components/common/status-pill';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import { PendingProposalsBadge } from '@/components/mods/proposal-review';
import { PowerControls } from '@/components/servers/power-controls';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBlueprint, useConsole, useMediaQuery, useServer } from '@/hooks';
import type { UseConsoleResult } from '@/hooks/use-console.js';
import { ApiError } from '@/lib/api-client.js';

/**
 * The frame every per-server screen sits in.
 *
 * This is the only place in the app that opens a console socket. One socket per server, held
 * here and shared through context, so the status pill on the Files tab is as live as the one
 * on the Console tab, a tab change never drops a log line, and a person clicking between five
 * tabs does not leave five sockets behind for the API to reap.
 *
 * Two failures get their own screens rather than a generic error: a server that does not
 * exist, and one that exists but is not yours. Those mean different things and have different
 * next steps, and collapsing them into "something went wrong" is how support tickets start.
 */

export interface ServerScope {
  server: Server;
  /** `undefined` until the blueprint query resolves; every consumer must tolerate that. */
  blueprint: Blueprint | undefined;
  /** The one shared socket: lines, stats, connection state and the command channel. */
  console: UseConsoleResult;
  /** The socket's status when it has one, the server record's otherwise. */
  status: ServerStatus;
  /** `host:port` of the primary allocation, or `null` before one is assigned. */
  primaryAddress: string | null;
}

const ServerScopeContext = createContext<ServerScope | null>(null);

/** Throws rather than returning null: a screen outside this layout is a routing bug. */
export function useServerScope(): ServerScope {
  const scope = useContext(ServerScopeContext);
  if (!scope) {
    throw new Error('useServerScope must be used inside the server layout route.');
  }
  return scope;
}

// ---------------------------------------------------------------------------------------

interface TabSpec {
  value: string;
  label: string;
  /** Relative to `/servers/:serverId`. The console lives at the index route. */
  segment: string;
  /** Only offered when the blueprint says the game actually has this. */
  feature?: keyof Blueprint['features'];
}

const TABS: readonly TabSpec[] = [
  { value: 'console', label: 'Console', segment: '' },
  { value: 'files', label: 'Files', segment: 'files' },
  { value: 'backups', label: 'Backups', segment: 'backups' },
  { value: 'schedules', label: 'Schedules', segment: 'schedules' },
  { value: 'players', label: 'Players', segment: 'players', feature: 'playerList' },
  { value: 'mods', label: 'Mods', segment: 'mods', feature: 'mods' },
  { value: 'monitoring', label: 'Monitoring', segment: 'monitoring' },
  { value: 'network', label: 'Network', segment: 'network' },
  { value: 'settings', label: 'Settings', segment: 'settings' },
];

function activeTabValue(pathname: string, serverId: string): string {
  const base = `/servers/${serverId}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, '') : '';
  const segment = rest.split('/')[0] ?? '';
  return TABS.find((tab) => tab.segment === segment)?.value ?? 'console';
}

// ---------------------------------------------------------------------------------------

export function ServerLayout() {
  const { serverId } = useParams<{ serverId: string }>();

  // Keying the scope on the id tears down and rebuilds the socket when someone navigates
  // straight from one server to another, which `useConsole` alone would not do cleanly.
  if (!serverId) return <UnknownServer />;
  return <ServerScopeProvider key={serverId} serverId={serverId} />;
}

function ServerScopeProvider({ serverId }: { serverId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const compact = useMediaQuery('(max-width: 639px)');

  const serverQuery = useServer(serverId);
  const server = serverQuery.data;
  const blueprintQuery = useBlueprint(server?.blueprintKey);
  // Mounted unconditionally: hooks cannot be called behind a branch, and the socket is
  // wanted from the moment the route opens rather than after the detail query settles.
  const consoleState = useConsole(serverId);

  const status: ServerStatus = consoleState.serverStatus ?? server?.status ?? 'offline';

  const scope = useMemo<ServerScope | null>(() => {
    if (!server) return null;
    const primary =
      server.allocations.find((allocation) => allocation.primary) ?? server.allocations[0];
    return {
      server: { ...server, status },
      blueprint: blueprintQuery.data,
      console: consoleState,
      status,
      primaryAddress: primary ? formatAddress(primary.hostIp, primary.hostPort) : null,
    };
  }, [server, blueprintQuery.data, consoleState, status]);

  if (serverQuery.isPending) return <ServerSkeleton />;

  if (serverQuery.isError) {
    const error = serverQuery.error;
    if (error instanceof ApiError && error.code === 'not_found') return <UnknownServer />;
    if (error instanceof ApiError && error.code === 'forbidden') return <NoAccess />;
    return (
      <>
        <PageHeader title="Server" />
        <PageBody>
          <ErrorState error={error} onRetry={() => void serverQuery.refetch()} />
        </PageBody>
      </>
    );
  }

  if (!scope || !server) return <ServerSkeleton />;

  const activeValue = activeTabValue(location.pathname, serverId);
  const tabs = TABS.filter(
    (tab) => !tab.feature || !blueprintQuery.data || blueprintQuery.data.features[tab.feature],
  );
  const blueprint = blueprintQuery.data;
  const subtitle = blueprint
    ? blueprint.game === blueprint.name
      ? blueprint.name
      : `${blueprint.game} · ${blueprint.name}`
    : server.blueprintKey;

  return (
    <ServerScopeContext.Provider value={scope}>
      {/*
        The tabs and their panel are one Ark Tabs root spanning the header and the content
        region, so the tablist and the tabpanel are genuinely associated rather than two
        lookalike widgets. Navigation is the source of truth: `value` comes from the URL and
        `onValueChange` pushes a route, never the other way round.
      */}
      <Tabs
        activationMode="manual"
        className="min-h-0 flex-1 gap-0"
        onValueChange={({ value }) => {
          const target = TABS.find((tab) => tab.value === value);
          if (!target) return;
          void navigate(`/servers/${serverId}${target.segment ? `/${target.segment}` : ''}`);
        }}
        value={activeValue}
      >
        <PageHeader
          description={subtitle}
          eyebrow={
            <Link
              className="inline-flex h-8 items-center gap-1.5 text-caption text-label-tertiary hover:text-label"
              to="/servers"
            >
              <ArrowLeft aria-hidden className="size-3.5" />
              All servers
            </Link>
          }
          title={server.name}
        >
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                <GameIcon
                  blueprintKey={server.blueprintKey}
                  hue={blueprint?.icon.hue}
                  monogram={blueprint?.icon.monogram}
                  name={server.name}
                  size="sm"
                />
                <StatusPill live size="md" status={status} />
                {/*
                  An agent can queue a mod for review from any tab, so the count belongs in the
                  frame rather than only on the Mods tab. It renders nothing when the queue is
                  empty, and is mounted only where mods exist so a Terraria server never issues
                  the query at all.
                */}
                {blueprint?.features.mods ? <PendingProposalsBadge serverId={server.id} /> : null}
                {scope.primaryAddress ? (
                  <CopyField
                    className="min-w-0 max-w-full"
                    label="Connect address"
                    value={scope.primaryAddress}
                    variant="inline"
                  />
                ) : (
                  <span className="text-caption text-label-tertiary">
                    No port assigned yet. One is allocated when the container is created.
                  </span>
                )}
              </div>

              <PowerControls dense={compact} server={server} showKill />
            </div>

            <ServerBanner exitCode={consoleState.lastExitCode} server={server} status={status} />

            <div
              /* On a phone the nine tabs must scroll sideways; wrapping them into three
                 stacked rows pushes the actual page below the fold. */
              className="-mx-6 overflow-x-auto px-6 lg:mx-0 lg:px-0"
            >
              <TabsList
                className="w-max min-w-full justify-start gap-x-1 border-b-0"
                variant="underline"
              >
                {tabs.map((tab) => (
                  <TabsTrigger
                    className="h-11 shrink-0 grow-0 rounded-sm px-3 text-subhead"
                    key={tab.value}
                    value={tab.value}
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </div>
        </PageHeader>

        {tabs.map((tab) => (
          <TabsContent className="min-h-0" key={tab.value} value={tab.value}>
            {tab.value === activeValue ? <Outlet /> : null}
          </TabsContent>
        ))}
      </Tabs>
    </ServerScopeContext.Provider>
  );
}

// ---------------------------------------------------------------------------------------

/**
 * The one banner slot. Only ever shows the single most urgent thing — three stacked alerts
 * above the tabs would push the page itself off screen.
 */
function ServerBanner({
  server,
  status,
  exitCode,
}: {
  server: Server;
  status: ServerStatus;
  exitCode: number | null;
}) {
  if (status === 'deleting') {
    return (
      <Alert variant="warning">
        <AlertTitle className="font-sans">This server is being deleted</AlertTitle>
        <AlertDescription>
          Its container, volume and backups are on their way out. Nothing on these tabs will save
          while that finishes.
        </AlertDescription>
      </Alert>
    );
  }

  if (status === 'suspended') {
    return (
      <Alert variant="warning">
        <AlertTitle className="font-sans">Suspended by an administrator</AlertTitle>
        <AlertDescription>
          The files and backups are intact and readable, but it cannot start until an administrator
          lifts the suspension.
        </AlertDescription>
      </Alert>
    );
  }

  if (status === 'install_failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle className="font-sans">The install script failed</AlertTitle>
        <AlertDescription>
          {server.name} never finished installing, so there is no game to start. The console below
          holds the install output. Reinstall from Settings once you have fixed the cause.
        </AlertDescription>
      </Alert>
    );
  }

  if (status === 'crashed') {
    return (
      <Alert variant="destructive">
        <AlertTitle className="font-sans">It exited unexpectedly</AlertTitle>
        <AlertDescription>
          {exitCode !== null || server.lastExitCode !== null ? (
            <>
              The process stopped with exit code{' '}
              <code className="font-mono">{exitCode ?? server.lastExitCode}</code>. The last lines
              in the console usually name the cause.
            </>
          ) : (
            'The process stopped on its own. The last lines in the console usually name the cause.'
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------------------

function ServerSkeleton() {
  return (
    <>
      <PageHeader title="Loading server">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-4">
            <Skeleton className="size-7 rounded-xs" />
            <Skeleton className="h-7 w-28 rounded-pill" />
            <Skeleton className="h-7 w-48 rounded-sm" />
          </div>
          <div className="flex gap-2">
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton className="h-11 w-24 rounded-sm" key={index} />
            ))}
          </div>
        </div>
      </PageHeader>
      <PageBody>
        <Skeleton className="h-64 rounded-md" />
        <span className="sr-only" role="status">
          Loading this server.
        </span>
      </PageBody>
    </>
  );
}

function UnknownServer() {
  return (
    <>
      <PageHeader title="No such server" />
      <PageBody>
        <EmptyState
          action={{ label: 'Back to your servers', to: '/servers' }}
          description={
            <>
              Nothing on this Platter has that id. It was probably deleted — deleting a server
              removes its container, its volume and its backups, and the link stops resolving
              straight away. If you followed a bookmark, it is out of date.
            </>
          }
          secondaryAction={{ label: 'Create a server', to: '/servers/new' }}
          title="That server isn’t here"
        />
      </PageBody>
    </>
  );
}

function NoAccess() {
  return (
    <>
      <PageHeader title="Not your server" />
      <PageBody>
        <EmptyState
          action={{ label: 'Back to your servers', to: '/servers' }}
          description={
            <>
              This server exists, but your account is neither its owner nor a subuser on it. Access
              is granted per server: ask its owner to add you under Settings → People, and they can
              choose exactly what you are allowed to do.
            </>
          }
          title="You don’t have access to this server"
        />
      </PageBody>
    </>
  );
}

// ---------------------------------------------------------------------------------------

/**
 * Shared page-level furniture for the tabs below this layout, kept here so nine screens do
 * not each invent their own section heading size.
 */
export const SECTION_TITLE = 'font-sans text-title-3 font-semibold';
export const ACTION_BUTTON = 'h-11 rounded-button px-5 text-subhead font-medium';

/** A disabled control always says why, and the reason is reachable from the control. */
export function DisabledHint({ children, id }: { children: React.ReactNode; id: string }) {
  return (
    <span className="text-caption text-label-tertiary" id={id}>
      {children}
    </span>
  );
}

/** The one-line explanation of a status, so every tab phrases it identically. */
export function statusHint(status: ServerStatus): string {
  return SERVER_STATUS_HINTS[status];
}
