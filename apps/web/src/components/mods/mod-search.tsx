import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'pixelarticons/react/Search.js';
import { ModCard, ModCardSkeleton } from '@/components/mods/mod-card';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { InstalledMod, ModSearchParams, ModSource, ModSummary } from '@/hooks';
import { useModSearch } from '@/hooks';
import { cn } from '@/lib/utils';

/**
 * Searching a registry for something this server can actually run.
 *
 * Every keystroke here costs an upstream request against a 40-per-minute budget shared by the
 * whole deployment (`apps/api/src/routes/mods.ts`), so the query is debounced and the results
 * are treated as fresh for a minute rather than refetched on focus.
 *
 * The API filters to the server's loader and Minecraft version by default. "Any Minecraft
 * version" is the deliberate escape hatch — it widens the search and is exactly the mode in
 * which incompatible results appear, which is why `ModCard` states incompatibility in words
 * instead of leaving it to be inferred.
 */

const SEARCH_DEBOUNCE_MS = 300;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

const SOURCE_LABEL: Record<ModSource, string> = {
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
};

export interface ModSearchProps {
  serverId: string;
  /** The server's concrete Minecraft version, or null when it tracks `LATEST`/`SNAPSHOT`. */
  gameVersion: string | null;
  /** Which registries this deployment can reach, from `GET /mods/installed`. */
  sources?: readonly ModSource[];
  /** Used only to mark results that are already on disk. */
  installed?: readonly InstalledMod[];
  onOpenMod: (mod: ModSummary) => void;
  className?: string;
}

export function ModSearch({
  serverId,
  gameVersion,
  sources = [],
  installed = [],
  onOpenMod,
  className,
}: ModSearchProps) {
  const [term, setTerm] = useState('');
  const [source, setSource] = useState<'' | ModSource>('');
  const [category, setCategory] = useState('');
  const [anyVersion, setAnyVersion] = useState(false);
  const debouncedTerm = useDebouncedValue(term.trim(), SEARCH_DEBOUNCE_MS);
  const resultsId = useId();

  const params = useMemo<ModSearchParams>(
    () => ({
      ...(debouncedTerm === '' ? {} : { q: debouncedTerm }),
      ...(source === '' ? {} : { source }),
      ...(category === '' ? {} : { category }),
      // `any` is the API's own opt-out token for the game-version constraint. Omitting the
      // parameter is what asks for the server's own version.
      ...(anyVersion ? { gameVersion: 'any' } : {}),
    }),
    [debouncedTerm, source, category, anyVersion],
  );

  const query = useModSearch(serverId, params);
  const pages = query.data?.pages ?? [];

  const hits = useMemo(() => {
    // A merged multi-source page can repeat a project across pages; keying by source+id keeps
    // React happy and stops the same mod appearing twice as the reader pages down.
    const seen = new Set<string>();
    const unique: ModSummary[] = [];
    for (const page of pages) {
      for (const hit of page.hits) {
        const key = `${hit.source}:${hit.projectId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(hit);
      }
    }
    return unique;
  }, [pages]);

  const installedByProject = useMemo(() => {
    const map = new Map<string, InstalledMod>();
    for (const mod of installed) map.set(`${mod.source}:${mod.projectId}`, mod);
    return map;
  }, [installed]);

  /** Offered from what the current results actually contain — there is no categories endpoint. */
  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const hit of hits) {
      for (const value of hit.categories) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    if (category !== '' && !counts.has(category)) counts.set(category, 0);
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 14)
      .map(([value]) => value);
  }, [hits, category]);

  const total = pages[0]?.total ?? 0;
  const failedSources = (pages[0]?.sources ?? []).filter((entry) => entry.error !== null);

  // A sentinel plus a real button: the observer is the convenience, the button is the only
  // path that works with a keyboard, with a screen reader, or with JS-driven scrolling off.
  const sentinel = useRef<HTMLDivElement | null>(null);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field className="min-w-56 flex-1">
            <FieldLabel>Search mods</FieldLabel>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-label-tertiary"
              />
              <Input
                aria-controls={resultsId}
                autoComplete="off"
                className="h-11 ps-9"
                name="q"
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Fabric API, world edit, anti-cheat…"
                type="search"
                value={term}
              />
            </div>
          </Field>

          {sources.length > 1 ? (
            <Field className="w-auto">
              <FieldLabel>Registry</FieldLabel>
              <NativeSelect
                className="[&>select]:h-11"
                name="source"
                onChange={(event) => setSource(event.target.value as '' | ModSource)}
                value={source}
              >
                <NativeSelectOption value="">All registries</NativeSelectOption>
                {sources.map((entry) => (
                  <NativeSelectOption key={entry} value={entry}>
                    {SOURCE_LABEL[entry]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}

          {categoryOptions.length > 0 ? (
            <Field className="w-auto">
              <FieldLabel>Category</FieldLabel>
              <NativeSelect
                className="[&>select]:h-11"
                name="category"
                onChange={(event) => setCategory(event.target.value)}
                value={category}
              >
                <NativeSelectOption value="">Any category</NativeSelectOption>
                {categoryOptions.map((entry) => (
                  <NativeSelectOption key={entry} value={entry}>
                    {entry}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-caption text-label-tertiary">
            {gameVersion === null
              ? 'This server tracks a moving version, so results are not filtered by Minecraft version.'
              : anyVersion
                ? `Showing every Minecraft version. This server runs ${gameVersion}.`
                : `Filtered to Minecraft ${gameVersion} and this server’s loader.`}
          </p>

          {gameVersion === null ? null : (
            <Button
              className="h-11 rounded-button px-4 text-subhead font-medium"
              onClick={() => setAnyVersion((previous) => !previous)}
              variant="outline"
            >
              {anyVersion ? `Only ${gameVersion}` : 'Any Minecraft version'}
            </Button>
          )}
        </div>
      </div>

      {failedSources.map((entry) => (
        <Alert key={entry.source} variant="warning">
          <AlertTitle className="font-sans">
            {SOURCE_LABEL[entry.source]} did not answer
          </AlertTitle>
          <AlertDescription>
            {entry.error} Results below come from the other registries only.
          </AlertDescription>
        </Alert>
      ))}

      <div aria-live="polite" className="sr-only" role="status">
        {query.isPending
          ? 'Searching.'
          : query.isError
            ? 'The search failed.'
            : `${hits.length} of ${total} results shown.`}
      </div>

      <div id={resultsId}>
        {query.isPending ? (
          <ul className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((index) => (
              <li key={index}>
                <ModCardSkeleton />
              </li>
            ))}
          </ul>
        ) : query.isError ? (
          <ErrorState
            error={query.error}
            isRetrying={query.isFetching}
            onRetry={() => void query.refetch()}
            title="The registry search failed"
            variant="inline"
          />
        ) : hits.length === 0 ? (
          <EmptyState
            description={
              debouncedTerm === ''
                ? 'Search by name, or browse by category. Everything found here has to be approved before it is installed.'
                : `Nothing matching “${debouncedTerm}” runs on this server’s loader${
                    anyVersion || gameVersion === null ? '' : ` and Minecraft ${gameVersion}`
                  }. Try a shorter term, or widen the version filter.`
            }
            size="sm"
            title={debouncedTerm === '' ? 'Find a mod' : 'No matches'}
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {hits.map((hit) => {
              const match = installedByProject.get(`${hit.source}:${hit.projectId}`);
              return (
                <li className="flex" key={`${hit.source}:${hit.projectId}`}>
                  <ModCard
                    /* Always the real version, not only in "any version" mode: when the
                       registry's own filter and Platter disagree, the card should say so. */
                    gameVersion={gameVersion}
                    installedVersion={match?.versionNumber ?? null}
                    mod={hit}
                    onOpen={onOpenMod}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {hits.length > 0 ? (
        <div className="flex flex-col items-center gap-2">
          <div aria-hidden className="h-px w-full" ref={sentinel} />
          {query.hasNextPage ? (
            <Button
              className="h-11 rounded-button px-5 text-subhead font-medium"
              isLoading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              variant="outline"
            >
              Load more results
            </Button>
          ) : (
            <p className="text-caption text-label-tertiary">
              That is every result for this search.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
