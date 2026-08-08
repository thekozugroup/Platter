import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  SERVER_STATUSES,
  formatMegabytes,
  type Paginated,
  type ServerStatus,
  type ServerSummary,
} from '@platter/shared';
import { Grid3x3 } from 'pixelarticons/react/Grid3x3.js';
import { ListBox } from 'pixelarticons/react/ListBox.js';
import { Search } from 'pixelarticons/react/Search.js';
import { Server } from 'pixelarticons/react/Server.js';
import { connectAddress } from '@/components/common/connect-address';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { GameIcon } from '@/components/common/game-icon';
import { SERVER_STATUS_LABELS, StatusPill } from '@/components/common/status-pill';
import { PageAction, PageBody, PageHeader } from '@/components/layout/page-header';
import { useBlueprintIndex } from '@/components/servers/blueprint-picker';
import { PowerControls } from '@/components/servers/power-controls';
import {
  ServerCard,
  ServerCardSkeleton,
  blueprintSubtitle,
  cardSurface,
} from '@/components/servers/server-card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Pagination,
  PaginationItems,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from '@/components/ui/segment-group';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';
import { cn } from '@/lib/utils';

/**
 * Every server on the installation, in a grid or a list.
 *
 * The filters live in the URL rather than in component state, so a filtered view is a link
 * someone can send to a colleague and the browser's back button undoes a filter change the way
 * people expect. The view choice is the one thing that does not belong in the URL — it is a
 * preference about this person's screen, not about what they are looking at — so it persists to
 * local storage instead.
 */

const VIEW_STORAGE_KEY = 'platter.servers.view';
const PER_PAGE = 24;
const SEARCH_DEBOUNCE_MS = 300;

type ViewMode = 'grid' | 'list';

const SORT_CHOICES = [
  { value: 'name:asc', label: 'Name, A to Z' },
  { value: 'name:desc', label: 'Name, Z to A' },
  { value: 'createdAt:desc', label: 'Newest first' },
  { value: 'createdAt:asc', label: 'Oldest first' },
  { value: 'status:asc', label: 'Status' },
] as const;

const DEFAULT_SORT = 'name:asc';

function readStoredView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    // Private browsing can throw on storage. A default view is a fine answer.
    return 'grid';
  }
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

// ---------------------------------------------------------------------------------------

/**
 * A row in the list view.
 *
 * The whole row is deliberately *not* a link: it carries power buttons, and a button inside an
 * anchor is invalid markup that behaves differently in every browser. The name is the link; the
 * row is a container.
 */
function ServerRow({
  server,
  subtitle,
  monogram,
  hue,
}: {
  server: ServerSummary;
  subtitle: string;
  monogram: string | undefined;
  hue: number | undefined;
}) {
  return (
    <li className={cn(cardSurface, 'p-4')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <GameIcon
          blueprintKey={server.blueprintKey}
          hue={hue}
          monogram={monogram}
          name={server.name}
          size="md"
        />

        <div className="min-w-0 flex-1 basis-48">
          <h3 className="font-sans text-body font-semibold tracking-title text-label">
            <Link
              className="rounded-xs underline-offset-4 hover:underline"
              to={`/servers/${server.id}`}
            >
              {server.name}
            </Link>
          </h3>
          <p className="mt-0.5 truncate text-footnote text-label-secondary">{subtitle}</p>
        </div>

        <div className="flex min-w-0 basis-56 flex-col gap-0.5">
          <code className="truncate font-mono text-caption text-label-secondary">
            {connectAddress(server) ?? 'Address assigned during install'}
          </code>
          <span className="tabular font-mono text-caption text-label-secondary">
            {formatMegabytes(server.memoryMb)}
            {server.playersOnline !== null && server.playersMax !== null
              ? ` · ${server.playersOnline}/${server.playersMax} online`
              : ''}
          </span>
        </div>

        <StatusPill status={server.status} />

        <PowerControls dense server={server} showKill={false} />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------------

export function ServersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const blueprints = useBlueprintIndex();

  const urlSearch = searchParams.get('q') ?? '';
  const statusFilter = searchParams.get('status') ?? '';
  const sortChoice = searchParams.get('sort') ?? DEFAULT_SORT;
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  const [view, setView] = useState<ViewMode>(readStoredView);
  const [searchDraft, setSearchDraft] = useState(urlSearch);
  const debouncedSearch = useDebounced(searchDraft, SEARCH_DEBOUNCE_MS);

  /** Writes a filter into the URL, always resetting to page one — page 7 of a new filter is
   *  almost never a page that exists. */
  const updateParams = useCallback(
    (changes: Record<string, string>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(changes)) {
            if (value === '') next.delete(key);
            else next.set(key, value);
          }
          if (!('page' in changes)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // The typed value reaches the URL only once typing pauses, so every keystroke is neither a
  // history entry nor a request.
  useEffect(() => {
    if (debouncedSearch === urlSearch) return;
    updateParams({ q: debouncedSearch });
  }, [debouncedSearch, urlSearch, updateParams]);

  const [sortField = 'name', sortOrder = 'asc'] = sortChoice.split(':');

  const params = useMemo(
    () => ({
      page,
      perPage: PER_PAGE,
      sort: sortField,
      order: sortOrder,
      ...(urlSearch ? { search: urlSearch } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
    }),
    [page, sortField, sortOrder, urlSearch, statusFilter],
  );

  const servers = useQuery({
    queryKey: queryKeys.servers.list(params),
    queryFn: () => api.get<Paginated<ServerSummary>>('/servers', { query: params }),
    // Matches the sidebar's cadence: fast enough that a status change surfaces, slow enough
    // that a screen left open on a second monitor is not a poll storm.
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  const filtered = urlSearch !== '' || statusFilter !== '';
  const rows = servers.data?.data ?? [];
  const total = servers.data?.meta.total ?? 0;
  const totalPages = servers.data?.meta.totalPages ?? 1;

  function chooseView(next: ViewMode) {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // A view that forgets itself is a much smaller problem than a crash here.
    }
  }

  function clearFilters() {
    setSearchDraft('');
    updateParams({ q: '', status: '' });
  }

  return (
    <>
      <PageHeader
        actions={<PageAction to="/servers/new">+ New server</PageAction>}
        description="Everything running on this installation, with the address players connect to."
        title="Servers"
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field className="min-w-56 max-w-xs flex-1">
            <FieldLabel>Search</FieldLabel>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-label-tertiary"
              />
              <Input
                autoComplete="off"
                className="h-11 ps-9"
                name="server-search"
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Name or address"
                type="search"
                value={searchDraft}
              />
            </div>
          </Field>

          <Field className="w-auto">
            <FieldLabel>Status</FieldLabel>
            {/*
              `NativeSelect` styles its wrapper, not the `<select>`, and its largest size stops
              at 36px. The child selector is the only way to reach the real control without
              editing a Shark component, and 44px is not negotiable.
            */}
            <NativeSelect
              className="w-44 [&>select]:h-11"
              onChange={(event) => updateParams({ status: event.target.value })}
              size="lg"
              value={statusFilter}
            >
              <NativeSelectOption value="">Any status</NativeSelectOption>
              {SERVER_STATUSES.map((status) => (
                <NativeSelectOption key={status} value={status}>
                  {SERVER_STATUS_LABELS[status]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>

          <Field className="w-auto">
            <FieldLabel>Sort</FieldLabel>
            <NativeSelect
              className="w-44 [&>select]:h-11"
              onChange={(event) => updateParams({ sort: event.target.value })}
              size="lg"
              value={sortChoice}
            >
              {SORT_CHOICES.map((choice) => (
                <NativeSelectOption key={choice.value} value={choice.value}>
                  {choice.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>

          <SegmentGroup
            aria-label="View"
            className="ms-auto rounded-md"
            onValueChange={({ value: next }) => chooseView(next === 'list' ? 'list' : 'grid')}
            value={view}
          >
            <SegmentGroupItem
              className="flex h-11 items-center gap-2 rounded-md px-4 text-subhead"
              value="grid"
            >
              <Grid3x3 aria-hidden className="relative z-1 size-4" />
              <SegmentGroupItemText>Grid</SegmentGroupItemText>
            </SegmentGroupItem>
            <SegmentGroupItem
              className="flex h-11 items-center gap-2 rounded-md px-4 text-subhead"
              value="list"
            >
              <ListBox aria-hidden className="relative z-1 size-4" />
              <SegmentGroupItemText>List</SegmentGroupItemText>
            </SegmentGroupItem>
          </SegmentGroup>
        </div>
      </PageHeader>

      <PageBody>
        {servers.isPending ? (
          <div aria-busy="true" className="grid gap-4 md:grid-cols-2">
            {[0, 1, 2, 3].map((index) => (
              <ServerCardSkeleton key={index} />
            ))}
            <span aria-live="polite" className="sr-only" role="status">
              Loading your servers
            </span>
          </div>
        ) : null}

        {servers.isError ? (
          <ErrorState
            error={servers.error}
            isRetrying={servers.isFetching}
            onRetry={() => void servers.refetch()}
            title="Couldn’t load your servers"
          />
        ) : null}

        {servers.isSuccess && rows.length === 0 && filtered ? (
          <EmptyState
            action={{ label: 'Clear the filters', onClick: clearFilters }}
            description={
              <>
                No server matches{urlSearch ? ` “${urlSearch}”` : ''}
                {statusFilter ? ` with status ${SERVER_STATUS_LABELS[statusFilter as ServerStatus]}` : ''}.
                Widen the search, or clear it to see everything.
              </>
            }
            title="Nothing matches that"
          />
        ) : null}

        {servers.isSuccess && rows.length === 0 && !filtered ? (
          <EmptyState
            action={{ label: 'Create your first server', to: '/servers/new' }}
            description="A server is one game, running in its own container, with its own world, files and backups. Platter installs it, keeps it running, and gives you a console, a file browser and scheduled backups from the moment it exists."
            icon={<Server />}
            secondaryAction={{ label: 'Back to the dashboard', to: '/' }}
            title="No servers yet"
          >
            <p className="max-w-prose text-subhead text-label-tertiary">
              Pick a game. Choose how much memory it gets. Press create.
            </p>
          </EmptyState>
        ) : null}

        {servers.isSuccess && rows.length > 0 ? (
          <div className="flex flex-col gap-6">
            <p aria-live="polite" className="text-caption text-label-secondary" role="status">
              {`${total} server${total === 1 ? '' : 's'}`}
              {filtered ? ' matching your filters' : ''}
              {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ''}
            </p>

            {view === 'grid' ? (
              <div className="grid gap-4 md:grid-cols-2">
                {rows.map((server) => (
                  <ServerCard
                    blueprint={blueprints.get(server.blueprintKey)}
                    key={server.id}
                    server={server}
                  />
                ))}
              </div>
            ) : (
              <ul className="flex flex-col gap-3">
                {rows.map((server) => {
                  const blueprint = blueprints.get(server.blueprintKey);
                  return (
                    <ServerRow
                      hue={blueprint?.icon.hue}
                      key={server.id}
                      monogram={blueprint?.icon.monogram}
                      server={server}
                      subtitle={blueprintSubtitle(server.blueprintKey, blueprint)}
                    />
                  );
                })}
              </ul>
            )}

            {totalPages > 1 ? (
              <Pagination
                // Shark's pagination buttons are 32px. Reaching them through their data-slots
                // is what brings every one of them to the 44px minimum.
                className={cn(
                  'pt-2',
                  '[&_[data-slot=pagination-item]]:size-11',
                  '[&_[data-slot=pagination-previous]]:h-11 [&_[data-slot=pagination-previous]]:px-4',
                  '[&_[data-slot=pagination-next]]:h-11 [&_[data-slot=pagination-next]]:px-4',
                  '[&_[data-slot=pagination-ellipsis]]:h-11',
                )}
                count={total}
                onPageChange={({ page: next }) => updateParams({ page: String(next) })}
                page={page}
                pageSize={PER_PAGE}
              >
                <PaginationPrevious />
                <PaginationItems />
                <PaginationNext />
              </Pagination>
            ) : null}
          </div>
        ) : null}
      </PageBody>
    </>
  );
}
