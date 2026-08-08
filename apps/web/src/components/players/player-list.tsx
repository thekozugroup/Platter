import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import type { PlayerRecord } from '@/components/players/player-actions';
import { useCompactViewport } from '@/components/players/player-actions';
import { PlayerRow } from '@/components/players/player-row';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * A list of players — either the people on the server right now, or everyone it has ever
 * seen.
 *
 * The two are one component because they are one list with a filter over it, and because the
 * roster endpoint returns both in a single payload. Splitting them into two components would
 * mean two sort orders, two empty states and two ways of laying a row out, which is exactly
 * how a screen ends up looking assembled rather than designed.
 */

export function sortPlayers(players: readonly PlayerRecord[]): PlayerRecord[] {
  return [...players].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const aSeen = a.lastSeen ? Date.parse(a.lastSeen) : 0;
    const bSeen = b.lastSeen ? Date.parse(b.lastSeen) : 0;
    if (aSeen !== bSeen) return bSeen - aSeen;
    return a.name.localeCompare(b.name);
  });
}

export function filterPlayers(
  players: readonly PlayerRecord[],
  search: string,
): readonly PlayerRecord[] {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return players;
  return players.filter((player) => player.name.toLowerCase().includes(needle));
}

export interface PlayerListProps {
  serverId: string;
  serverName: string;
  players: readonly PlayerRecord[];
  /** Why nothing can be changed right now. Null when actions are available. */
  blockedReason: string | null;
  /** `online` narrows to players connected now; `all` is the whole roster. */
  scope: 'online' | 'all';
  /** A search box, worth it once a roster runs to dozens of names. */
  searchable?: boolean;
  isLoading?: boolean;
  emptyTitle: string;
  emptyDescription: string;
  className?: string;
}

export function PlayerList({
  serverId,
  serverName,
  players,
  blockedReason,
  scope,
  searchable = false,
  isLoading = false,
  emptyTitle,
  emptyDescription,
  className,
}: PlayerListProps) {
  const [search, setSearch] = useState('');
  const compact = useCompactViewport();

  const visible = useMemo(() => {
    const scoped = scope === 'online' ? players.filter((player) => player.online) : players;
    return filterPlayers(sortPlayers(scoped), searchable ? search : '');
  }, [players, scope, search, searchable]);

  if (isLoading) {
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        <Skeleton className="h-16 w-full rounded-md" />
        <Skeleton className="h-16 w-full rounded-md" />
        <Skeleton className="h-16 w-full rounded-md" />
      </div>
    );
  }

  const searchIsEmpty = search.trim().length > 0 && visible.length === 0;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {searchable ? (
        <div className="flex flex-col gap-2">
          <Field className="max-w-xs">
            <FieldLabel>Search players</FieldLabel>
            <Input
              className="h-11"
              name="player-search"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name"
              type="search"
              value={search}
            />
          </Field>
          <p aria-live="polite" className="text-caption text-label-tertiary" role="status">
            {visible.length === players.length
              ? `${players.length.toLocaleString()} ${players.length === 1 ? 'player' : 'players'}`
              : `${visible.length.toLocaleString()} of ${players.length.toLocaleString()} shown`}
          </p>
        </div>
      ) : null}

      {searchIsEmpty ? (
        <EmptyState
          description={`Nobody on this server matches “${search.trim()}”. Names are matched anywhere, not just at the start.`}
          size="sm"
          title="No player by that name"
        />
      ) : visible.length === 0 ? (
        <EmptyState description={emptyDescription} size="sm" title={emptyTitle} />
      ) : (
        <ul className="divide-y divide-separator border-t border-separator">
          {visible.map((player) => (
            <PlayerRow
              blockedReason={blockedReason}
              compact={compact}
              key={player.name}
              player={player}
              serverId={serverId}
              serverName={serverName}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
