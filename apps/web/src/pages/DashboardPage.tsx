import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link } from 'react-router';
import {
  formatCount,
  formatMegabytes,
  formatRelativeTime,
  type AuditEntry,
  type Node,
  type Paginated,
  type ServerStatus,
  type ServerSummary,
} from '@platter/shared';
import { Server as ServerIcon } from 'pixelarticons/react/Server.js';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { SERVER_STATUS_HINTS, StatusPill } from '@/components/common/status-pill';
import { PageAction, PageBody, PageHeader } from '@/components/layout/page-header';
import { useSidebarServers } from '@/components/layout/sidebar';
import { useBlueprintIndex } from '@/components/servers/blueprint-picker';
import { PowerControls } from '@/components/servers/power-controls';
import { ServerCard, ServerCardSkeleton, cardSurface } from '@/components/servers/server-card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { api } from '@/lib/api-client.js';
import { useAuth } from '@/lib/auth.js';
import { queryKeys } from '@/lib/query.js';
import { cn } from '@/lib/utils';

/**
 * The screen people leave open on a second monitor.
 *
 * Ordered by what would make someone walk over to the machine: anything crashed comes first,
 * with the button that fixes it right there; then how much of the node is spoken for; then the
 * fleet; then what changed recently. Nothing below the fold is more urgent than something above
 * it.
 *
 * Live, deliberately not twitchy. The server list rides on the sidebar's existing ten-second
 * poll rather than opening a second one, and everything else refreshes on a slower cadence —
 * a dashboard that repaints every second is unreadable and a dashboard that never repaints is
 * a screenshot.
 */

const ACTIVITY_REFRESH_MS = 30_000;
const CAPACITY_REFRESH_MS = 30_000;

/** Statuses that mean a human has to do something. Ordered worst first. */
const NEEDS_ATTENTION: readonly ServerStatus[] = ['crashed', 'install_failed', 'suspended'];

// ---------------------------------------------------------------------------------------

function SectionHeading({
  title,
  action,
}: {
  title: string;
  action?: { label: string; to: string };
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      {/* h2 keeps the pixel display face here: at 24px it is legible and it is a real heading. */}
      <h2 className="text-title-2 text-label">{title}</h2>
      {action ? (
        <Link
          className="hit-target -me-2 inline-flex min-h-11 items-center rounded-xs px-2 text-subhead font-medium text-label-secondary underline-offset-4 hover:text-label hover:underline"
          to={action.to}
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
}) {
  return (
    <div className={cn(cardSurface, 'flex flex-col gap-1 p-4')}>
      <span className="text-caption font-medium text-label-secondary">{label}</span>
      <span className="tabular text-title-2 font-medium text-label">{value}</span>
      {detail ? <span className="text-caption text-label-secondary">{detail}</span> : null}
    </div>
  );
}

/**
 * An allocation meter. The bar is never the only representation — the exact figures sit above
 * it in text, because a bar alone cannot be read by a screen reader or at a glance.
 */
function AllocationMeter({
  label,
  usedLabel,
  totalLabel,
  percent,
  caption,
}: {
  label: string;
  usedLabel: string;
  totalLabel: string;
  percent: number;
  caption: string;
}) {
  return (
    <div className={cn(cardSurface, 'flex flex-col gap-2 p-4')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-caption font-medium text-label-secondary">{label}</span>
        <span className="tabular font-mono text-caption text-label-secondary">
          {usedLabel} of {totalLabel}
        </span>
      </div>
      {/* `Progress` renders its own track and range; children would duplicate them. */}
      <Progress
        aria-label={`${label}: ${usedLabel} of ${totalLabel} allocated`}
        max={100}
        value={Math.min(100, Math.round(percent))}
      />
      <span className="text-caption text-label-secondary">{caption}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------

/** A readable sentence per audit action. Unmapped actions degrade to their verb, never a blank. */
function auditSentence(entry: AuditEntry): string {
  const actor = entry.actorName ?? 'Platter';
  const target = entry.targetName ?? entry.targetId ?? 'something';
  const power = typeof entry.metadata.action === 'string' ? entry.metadata.action : 'power';

  switch (entry.action) {
    case 'server.created':
      return `${actor} created ${target}`;
    case 'server.deleted':
      return `${actor} deleted ${target}`;
    case 'server.updated':
      return `${actor} changed ${target}`;
    case 'server.reinstalled':
      return `${actor} reinstalled ${target}`;
    case 'server.power':
      return `${actor} sent ${power} to ${target}`;
    case 'server.command':
      return `${actor} ran a console command on ${target}`;
    case 'server.subuser_added':
      return `${actor} invited someone to ${target}`;
    case 'server.subuser_removed':
      return `${actor} removed a collaborator from ${target}`;
    case 'backup.created':
      return `${actor} backed up ${target}`;
    case 'backup.restored':
      return `${actor} restored ${target} from a backup`;
    case 'backup.deleted':
      return `${actor} deleted a backup of ${target}`;
    case 'schedule.executed':
      return `A schedule ran on ${target}`;
    case 'schedule.created':
      return `${actor} scheduled a task on ${target}`;
    case 'file.written':
      return `${actor} edited a file on ${target}`;
    case 'file.uploaded':
      return `${actor} uploaded a file to ${target}`;
    case 'node.created':
      return `${actor} added the node ${target}`;
    case 'node.updated':
      return `${actor} changed the node ${target}`;
    case 'settings.updated':
      return `${actor} changed the installation settings`;
    default:
      return `${actor} — ${entry.action.replace(/[._]/g, ' ')}`;
  }
}

// ---------------------------------------------------------------------------------------

export function DashboardPage() {
  const { user, isAdmin } = useAuth();
  const blueprints = useBlueprintIndex();

  // Shares the sidebar's cache entry: one poll drives both the nav dots and this screen.
  const servers = useSidebarServers();

  const activity = useQuery({
    queryKey: queryKeys.audit.list({ perPage: 8 }),
    queryFn: () =>
      api.get<Paginated<AuditEntry>>('/audit', { query: { perPage: 8 } }),
    refetchInterval: ACTIVITY_REFRESH_MS,
  });

  // `/nodes` is admin-only. A member sees their own allocation without a denominator rather
  // than a permission error they can do nothing about.
  const nodes = useQuery({
    queryKey: queryKeys.nodes.all,
    queryFn: () => api.get<{ data: Node[] }>('/nodes'),
    enabled: isAdmin,
    refetchInterval: CAPACITY_REFRESH_MS,
  });

  const rows = useMemo(() => servers.data?.data ?? [], [servers.data]);

  const summary = useMemo(() => {
    const counts = new Map<ServerStatus, number>();
    let memoryMb = 0;
    let cpuCores = 0;
    let playersOnline = 0;
    let playersKnown = false;

    for (const server of rows) {
      counts.set(server.status, (counts.get(server.status) ?? 0) + 1);
      memoryMb += server.memoryMb;
      cpuCores += server.cpuCores;
      if (server.playersOnline !== null) {
        playersOnline += server.playersOnline;
        playersKnown = true;
      }
    }

    const attention = rows.filter((server) => NEEDS_ATTENTION.includes(server.status));

    return {
      counts,
      memoryMb,
      cpuCores,
      playersOnline,
      playersKnown,
      attention,
      running: counts.get('running') ?? 0,
      total: rows.length,
    };
  }, [rows]);

  const capacity = useMemo(() => {
    const all = nodes.data?.data ?? [];
    if (all.length === 0) return null;

    return {
      memoryTotalMb: all.reduce((sum, node) => sum + node.memoryTotalMb, 0),
      memoryAllocatedMb: all.reduce((sum, node) => sum + node.memoryAllocatedMb, 0),
      diskTotalMb: all.reduce((sum, node) => sum + node.diskTotalMb, 0),
      diskAllocatedMb: all.reduce((sum, node) => sum + node.diskAllocatedMb, 0),
      cpuCores: all.reduce((sum, node) => sum + node.cpuCores, 0),
      offline: all.filter((node) => node.status !== 'online'),
      count: all.length,
    };
  }, [nodes.data]);

  const greeting = user ? `Hello, ${user.displayName.split(' ')[0] ?? user.displayName}.` : null;

  return (
    <>
      <PageHeader
        actions={<PageAction to="/servers/new">+ New server</PageAction>}
        description={
          greeting
            ? `${greeting} Everything you are running, and anything that needs you.`
            : 'Everything you are running, and anything that needs you.'
        }
        title="Dashboard"
      />

      <PageBody>
        <div className="flex flex-col gap-12 lg:gap-16">
          {/* ---- Anything broken, first, with the action that fixes it ---- */}
          {summary.attention.length > 0 ? (
            <section aria-labelledby="attention-heading" className="flex flex-col gap-4">
              <h2 className="text-title-2 text-label" id="attention-heading">
                Needs you
              </h2>
              <ul className="flex flex-col gap-3">
                {summary.attention.map((server) => (
                  <li
                    className={cn(
                      cardSurface,
                      'flex flex-wrap items-center gap-x-4 gap-y-3 border-danger/30 bg-danger-subtle p-4',
                    )}
                    key={server.id}
                  >
                    <div className="min-w-0 flex-1 basis-56">
                      <h3 className="font-sans text-body font-semibold tracking-title text-label">
                        <Link
                          className="rounded-xs underline-offset-4 hover:underline"
                          to={`/servers/${server.id}`}
                        >
                          {server.name}
                        </Link>
                      </h3>
                      <p className="mt-0.5 text-footnote text-label-secondary">
                        {SERVER_STATUS_HINTS[server.status]}
                      </p>
                    </div>
                    <StatusPill size="md" status={server.status} />
                    <div className="flex flex-wrap items-center gap-2">
                      <PowerControls server={server} showKill={false} />
                      <Button
                        asChild
                        className="h-11 rounded-button px-4 text-subhead font-medium"
                        size="lg"
                        variant="ghost"
                      >
                        <Link to={`/servers/${server.id}`}>Open console</Link>
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* ---- Fleet and capacity ---- */}
          <section aria-labelledby="fleet-heading" className="flex flex-col gap-4">
            <h2 className="text-title-2 text-label" id="fleet-heading">
              At a glance
            </h2>

            {servers.isError ? (
              <ErrorState
                error={servers.error}
                onRetry={() => void servers.refetch()}
                title="Couldn’t load your servers"
                variant="inline"
              />
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                detail={summary.total === 0 ? 'None yet' : `${summary.running} running`}
                label="Servers"
                value={servers.isPending ? '—' : String(summary.total)}
              />
              <StatTile
                detail={
                  summary.total === 0
                    ? undefined
                    : `${summary.total - summary.running} not running`
                }
                label="Running"
                value={servers.isPending ? '—' : String(summary.running)}
              />
              <StatTile
                detail={
                  summary.attention.length === 0
                    ? 'Nothing to look at'
                    : 'Crashed, failed or suspended'
                }
                label="Needs attention"
                value={servers.isPending ? '—' : String(summary.attention.length)}
              />
              <StatTile
                detail={summary.playersKnown ? 'Across every server' : 'No server reports players'}
                label="Players online"
                value={servers.isPending || !summary.playersKnown ? '—' : String(summary.playersOnline)}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {capacity ? (
                <AllocationMeter
                  caption={`${formatMegabytes(Math.max(0, capacity.memoryTotalMb - capacity.memoryAllocatedMb))} still free across ${formatCount(capacity.count, 'node')}.`}
                  label="Memory allocated"
                  percent={
                    capacity.memoryTotalMb > 0
                      ? (capacity.memoryAllocatedMb / capacity.memoryTotalMb) * 100
                      : 0
                  }
                  totalLabel={formatMegabytes(capacity.memoryTotalMb)}
                  usedLabel={formatMegabytes(capacity.memoryAllocatedMb)}
                />
              ) : (
                <StatTile
                  detail="Reserved for your servers, whether or not they are running"
                  label="Memory allocated"
                  value={servers.isPending ? '—' : formatMegabytes(summary.memoryMb)}
                />
              )}

              {capacity ? (
                <AllocationMeter
                  caption={`${formatMegabytes(Math.max(0, capacity.diskTotalMb - capacity.diskAllocatedMb))} still free across ${formatCount(capacity.count, 'node')}.`}
                  label="Disk allocated"
                  percent={
                    capacity.diskTotalMb > 0
                      ? (capacity.diskAllocatedMb / capacity.diskTotalMb) * 100
                      : 0
                  }
                  totalLabel={formatMegabytes(capacity.diskTotalMb)}
                  usedLabel={formatMegabytes(capacity.diskAllocatedMb)}
                />
              ) : (
                <StatTile
                  detail={
                    summary.cpuCores === 0
                      ? 'Every server runs without a CPU quota'
                      : 'Quota across your servers'
                  }
                  label="CPU allocated"
                  value={
                    servers.isPending
                      ? '—'
                      : `${summary.cpuCores.toFixed(summary.cpuCores % 1 === 0 ? 0 : 1)} cores`
                  }
                />
              )}
            </div>

            {capacity && capacity.offline.length > 0 ? (
              <p
                className="rounded-sm border border-warning/25 bg-warning-subtle px-3 py-2 text-subhead text-warning"
                role="alert"
              >
                Not answering: {capacity.offline.map((node) => node.name).join(', ')}. Servers on{' '}
                {capacity.offline.length === 1 ? 'that node' : 'those nodes'} cannot be started
                until the Docker socket is reachable again.
              </p>
            ) : null}
          </section>

          {/* ---- The servers themselves ---- */}
          <section aria-labelledby="servers-heading" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-title-2 text-label" id="servers-heading">
                Your servers
              </h2>
              {summary.total > 6 ? (
                <Link
                  className="rounded-xs text-subhead font-medium text-label-secondary underline-offset-4 hover:text-label hover:underline"
                  to="/servers"
                >
                  See all {summary.total}
                </Link>
              ) : null}
            </div>

            {servers.isPending ? (
              <div aria-busy="true" className="grid gap-4 md:grid-cols-2">
                <ServerCardSkeleton />
                <ServerCardSkeleton />
                <span aria-live="polite" className="sr-only" role="status">
                  Loading your servers
                </span>
              </div>
            ) : null}

            {servers.isSuccess && summary.total === 0 ? (
              <EmptyState
                action={{ label: 'Create your first server', to: '/servers/new' }}
                description="Platter runs each game in its own container and gives you a console, a file browser, scheduled backups and a live view of what it is doing. Nothing is running yet."
                icon={<ServerIcon />}
                title="Nothing running yet"
              >
                <p className="max-w-prose text-subhead text-label-tertiary">
                  Pick a game. Choose how much memory it gets. Press create.
                </p>
              </EmptyState>
            ) : null}

            {servers.isSuccess && summary.total > 0 ? (
              <div className="grid gap-4 md:grid-cols-2">
                {rows.slice(0, 6).map((server: ServerSummary) => (
                  <ServerCard
                    blueprint={blueprints.get(server.blueprintKey)}
                    key={server.id}
                    server={server}
                  />
                ))}
              </div>
            ) : null}
          </section>

          {/* ---- What changed ---- */}
          <section aria-labelledby="activity-heading" className="flex flex-col gap-4">
            <SectionHeading
              {...(isAdmin ? { action: { label: 'Full audit log', to: '/admin/audit' } } : {})}
              title="Recent activity"
            />

            {activity.isPending ? (
              <div aria-busy="true" className="flex flex-col gap-2">
                <div className="skeleton h-10 rounded-sm" />
                <div className="skeleton h-10 rounded-sm" />
                <div className="skeleton h-10 rounded-sm" />
              </div>
            ) : null}

            {activity.isError ? (
              <ErrorState
                error={activity.error}
                onRetry={() => void activity.refetch()}
                title="Couldn’t load recent activity"
                variant="inline"
              />
            ) : null}

            {activity.isSuccess && activity.data.data.length === 0 ? (
              <p className="text-subhead text-label-secondary">
                Nothing has happened yet. Every action anyone takes — a restart, a file edit, a
                backup — is recorded here with who did it and when.
              </p>
            ) : null}

            {activity.isSuccess && activity.data.data.length > 0 ? (
              <ul className="divide-y divide-separator border-y border-separator">
                {activity.data.data.map((entry) => (
                  <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3" key={entry.id}>
                    <span className="min-w-0 flex-1 text-subhead text-label">
                      {auditSentence(entry)}
                    </span>
                    <time
                      className="tabular shrink-0 text-caption text-label-secondary"
                      dateTime={entry.createdAt}
                      // Relative under a week, exact on hover. Both, always.
                      title={new Date(entry.createdAt).toLocaleString()}
                    >
                      {formatRelativeTime(entry.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </PageBody>
    </>
  );
}
