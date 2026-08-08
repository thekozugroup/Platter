import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { formatMegabytes, type Blueprint, type BlueprintSummary } from '@platter/shared';
import { Search } from 'pixelarticons/react/Search.js';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { GameIcon } from '@/components/common/game-icon';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';
import { cn } from '@/lib/utils';

/**
 * Step one of the create flow: which game.
 *
 * A radio group, not a dropdown. Twelve games with artwork is a browsing problem, and a
 * `<select>` hides eleven of them behind a click. Ark's radio group gives the whole grid real
 * roving-arrow-key navigation for free, which a grid of buttons would not have.
 */

/** `GET /blueprints` — the whole catalogue, a dozen entries that ship with the build. */
export function useBlueprints(): UseQueryResult<BlueprintSummary[]> {
  return useQuery({
    queryKey: queryKeys.blueprints.all,
    queryFn: async () => {
      const body = await api.get<{ data: BlueprintSummary[] }>('/blueprints');
      return body.data;
    },
    // The catalogue is compiled into the binary; it cannot change while the tab is open.
    staleTime: 30 * 60_000,
  });
}

/** `GET /blueprints/:key` — variables, ports and file templates for one game. */
export function useBlueprint(key: string | null): UseQueryResult<Blueprint> {
  return useQuery({
    queryKey: queryKeys.blueprints.detail(key ?? 'none'),
    queryFn: () => api.get<Blueprint>(`/blueprints/${key ?? ''}`),
    enabled: key !== null,
    staleTime: 30 * 60_000,
  });
}

/**
 * Blueprints keyed by their slug, for every screen that has a server and needs the game's
 * real monogram and name. Shares one cache entry with the picker.
 */
export function useBlueprintIndex(): Map<string, BlueprintSummary> {
  const { data } = useBlueprints();
  return useMemo(
    () => new Map((data ?? []).map((blueprint) => [blueprint.key, blueprint])),
    [data],
  );
}

/**
 * Ark renders the item's content inside a `<span data-slot="radio-group-item-text">` carrying
 * `w-fit`, which would stop a card's text from filling the card. `flex-row-reverse` puts the
 * radio control at the trailing edge and the text at the leading one, so `w-fit` is harmless
 * and the layout needs no override of a Shark component's internals.
 */
const OPTION_CARD = cn(
  'w-full flex-row-reverse items-start justify-between gap-3',
  'rounded-md border border-separator-strong bg-surface p-4 text-start',
  'transition-colors duration-150 ease-standard',
  'hover:bg-surface-hover',
  'has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2',
  'has-[input:focus-visible]:outline-label',
  'data-[state=checked]:border-label data-[state=checked]:bg-surface-active',
  'motion-reduce:transition-none!',
);

export interface BlueprintPickerProps {
  value: string | null;
  onChange: (key: string) => void;
  className?: string;
}

export function BlueprintPicker({ value, onChange, className }: BlueprintPickerProps) {
  const blueprints = useBlueprints();
  const [search, setSearch] = useState('');

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = blueprints.data ?? [];
    if (needle === '') return all;
    return all.filter((blueprint) =>
      [blueprint.name, blueprint.game, blueprint.summary, blueprint.category, blueprint.key]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [blueprints.data, search]);

  if (blueprints.isError) {
    return (
      <ErrorState
        error={blueprints.error}
        onRetry={() => void blueprints.refetch()}
        title="Couldn’t load the game catalogue"
        variant="inline"
      />
    );
  }

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <Field className="max-w-sm">
        <FieldLabel>Search games</FieldLabel>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-label-tertiary"
          />
          <Input
            autoComplete="off"
            className="h-11 ps-9"
            name="blueprint-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Minecraft, Valheim, Factorio…"
            type="search"
            value={search}
          />
        </div>
      </Field>

      {blueprints.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div className="skeleton h-28 rounded-md" key={index} />
          ))}
          <span aria-live="polite" className="sr-only" role="status">
            Loading the game catalogue
          </span>
        </div>
      ) : null}

      {blueprints.isSuccess && matches.length === 0 ? (
        <EmptyState
          description={
            <>
              Nothing in the catalogue matches “{search.trim()}”. Blueprints ship with Platter,
              so the list is the same on every install of this version.
            </>
          }
          secondaryAction={{ label: 'Clear the search', onClick: () => setSearch('') }}
          size="sm"
          title="No game by that name"
        />
      ) : null}

      {blueprints.isSuccess && matches.length > 0 ? (
        <>
          <RadioGroup
            aria-label="Game"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            // Ark reports `null` when a group is cleared; this one never is, so ignore it
            // rather than pushing an empty selection into the wizard's state.
            onValueChange={({ value: next }) => {
              if (next !== null) onChange(next);
            }}
            value={value ?? ''}
          >
            {matches.map((blueprint) => (
              <RadioGroupItem className={OPTION_CARD} key={blueprint.key} value={blueprint.key}>
                <span className="flex flex-col gap-2">
                  <span className="flex items-center gap-2.5">
                    <GameIcon
                      hue={blueprint.icon.hue}
                      monogram={blueprint.icon.monogram}
                      name={blueprint.name}
                      size="md"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-body font-semibold tracking-title text-label">
                        {blueprint.game}
                      </span>
                      <span className="text-caption font-normal text-label-secondary">
                        {blueprint.name}
                      </span>
                    </span>
                  </span>
                  <span className="text-footnote font-normal text-balance text-label-secondary">
                    {blueprint.summary}
                  </span>
                  <span className="tabular text-caption font-normal text-label-secondary">
                    {formatMegabytes(blueprint.recommendedMemoryMb)} recommended
                    {blueprint.features.mods ? ' · takes mods' : ''}
                  </span>
                </span>
              </RadioGroupItem>
            ))}
          </RadioGroup>

          <p aria-live="polite" className="sr-only" role="status">
            {`${matches.length} game${matches.length === 1 ? '' : 's'} listed`}
          </p>
        </>
      ) : null}
    </div>
  );
}
