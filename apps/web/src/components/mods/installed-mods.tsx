import { useState } from 'react';
import { formatBytes, formatRelativeTime } from '@platter/shared';
import { Package } from 'pixelarticons/react/Package.js';
import { ModIcon, modSurface } from '@/components/mods/mod-card';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { InstalledMod, ModSummary, ModUpdateCandidate } from '@/hooks';
import { useInstalledMods, useModUpdates, useUninstallMod } from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { cn } from '@/lib/utils';

/**
 * What is actually on this server's disk, and what could be newer.
 *
 * The update check is not a background poll: it costs one upstream request per installed mod
 * against a six-per-minute budget (`apps/api/src/routes/mods.ts`), so it runs only when
 * somebody asks. An available update is reported, never applied on its own — the button on an
 * out-of-date row opens the listing, where swapping the version in is one press and says what
 * it would do first.
 */

function modKey(mod: { source: string; projectId: string }): string {
  return `${mod.source}:${mod.projectId}`;
}

export interface InstalledModsProps {
  serverId: string;
  /** Opens the full listing, which is where a newer version gets swapped in. */
  onOpenMod: (mod: Pick<ModSummary, 'source' | 'projectId' | 'slug' | 'title'>) => void;
  className?: string;
}

export function InstalledMods({ serverId, onOpenMod, className }: InstalledModsProps) {
  const query = useInstalledMods(serverId);
  const updates = useModUpdates(serverId);
  const uninstall = useUninstallMod(serverId);
  const [pendingRemoval, setPendingRemoval] = useState<InstalledMod | null>(null);

  const mods = query.data?.data ?? [];
  const updateByMod = new Map<string, ModUpdateCandidate>(
    (updates.data?.data ?? []).map((candidate) => [modKey(candidate.installed), candidate]),
  );

  if (query.isPending) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <span className="sr-only" role="status">
          Loading installed mods.
        </span>
        {[0, 1, 2].map((index) => (
          <Skeleton className="h-24 rounded-md" key={index} />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        className={className}
        error={query.error}
        isRetrying={query.isFetching}
        onRetry={() => void query.refetch()}
        title="Couldn’t read the installed mods"
        variant="inline"
      />
    );
  }

  if (mods.length === 0) {
    return (
      <EmptyState
        className={className}
        description="Nothing yet. Search above, open anything that looks right, and add it — Platter downloads it, checks the file is the one it was offered, and remembers where it came from."
        icon={<Package />}
        size="sm"
        title="No mods on this server yet"
      >
        <p className="max-w-prose text-caption text-label-tertiary">
          Files you copied into <code className="font-mono">mods/</code> yourself still load
          normally. They are not listed here because Platter has no record of where they came from.
        </p>
      </EmptyState>
    );
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-subhead text-label-secondary">
          {mods.length} {mods.length === 1 ? 'mod' : 'mods'} added by Platter
        </p>
        <div className="flex flex-col items-end gap-1">
          <Button
            className="h-11 rounded-button px-5 text-subhead font-medium"
            isLoading={updates.isFetching}
            onClick={() => void updates.refetch()}
            variant="outline"
          >
            Check for updates
          </Button>
          {updates.isFetched && !updates.isFetching && updateByMod.size === 0 ? (
            <p className="text-caption text-label-tertiary" role="status">
              Everything is on its newest compatible version.
            </p>
          ) : null}
        </div>
      </div>

      {updates.isError ? (
        <p className="text-caption text-danger" role="status">
          {errorMessage(updates.error)}
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {mods.map((mod) => (
          <InstalledRow
            candidate={updateByMod.get(modKey(mod)) ?? null}
            key={modKey(mod)}
            mod={mod}
            onOpen={() => onOpenMod(mod)}
            onRemove={() => setPendingRemoval(mod)}
          />
        ))}
      </ul>

      <p aria-live="polite" className="text-caption text-danger" role="status">
        {uninstall.isError ? errorMessage(uninstall.error) : null}
      </p>

      <AlertDialog
        onOpenChange={(details) => {
          if (!details.open) setPendingRemoval(null);
        }}
        open={pendingRemoval !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Remove {pendingRemoval?.title}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes a file from the server’s disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <p className="text-subhead text-label-secondary">
              <code className="font-mono">
                {pendingRemoval?.target}/{pendingRemoval?.filename}
              </code>{' '}
              is deleted. Anything that depends on it will fail to load, and worlds that use its
              blocks or items may lose them on the next start. The server keeps running until it is
              restarted.
            </p>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11 rounded-button px-5 text-subhead font-medium">
              Keep it
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 rounded-button px-5 text-subhead font-medium"
              isLoading={uninstall.isPending}
              onClick={() => {
                if (!pendingRemoval) return;
                uninstall.mutate(
                  { source: pendingRemoval.source, project: pendingRemoval.projectId },
                  { onSuccess: () => setPendingRemoval(null) },
                );
              }}
              variant="destructive"
            >
              Delete the file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------------------

function InstalledRow({
  mod,
  candidate,
  onOpen,
  onRemove,
}: {
  mod: InstalledMod;
  candidate: ModUpdateCandidate | null;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <li className={cn(modSurface, 'flex flex-col gap-3 p-4')}>
      <div className="flex items-start gap-3">
        <ModIcon iconUrl={null} size="md" title={mod.title} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h4 className="min-w-0 font-sans text-body font-semibold tracking-title text-label">
              {mod.title}
            </h4>
            <code className="font-mono text-caption text-label-secondary">{mod.versionNumber}</code>
          </div>
          <p className="mt-0.5 text-caption text-label-tertiary">
            <code className="font-mono">
              {mod.target}/{mod.filename}
            </code>
            <span aria-hidden> · </span>
            <span className="tabular">{formatBytes(mod.sizeBytes)}</span>
          </p>
          <p className="mt-0.5 text-caption text-label-tertiary">
            {mod.installedByName === null ? 'Added' : `Added by ${mod.installedByName}`}{' '}
            <time dateTime={mod.installedAt} title={new Date(mod.installedAt).toLocaleString()}>
              {formatRelativeTime(mod.installedAt)}
            </time>
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button
            className="h-11 rounded-button px-4 text-subhead font-medium"
            onClick={onOpen}
            variant="ghost"
          >
            Details
          </Button>
          <Button
            aria-label={`Remove ${mod.title}`}
            className="h-11 rounded-button px-4 text-subhead font-medium text-danger hover:text-danger"
            onClick={onRemove}
            variant="ghost"
          >
            Remove
          </Button>
        </div>
      </div>

      {candidate ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm bg-bg-sunken px-3 py-2">
          <p className="min-w-0 text-caption text-label-secondary">
            <span className="font-medium text-label">
              Version {candidate.latest.versionNumber} is available.
            </span>{' '}
            {candidate.prerelease
              ? 'It is a test build — the author does not consider it finished.'
              : 'It is a finished release, and it runs on this server.'}
          </p>
          <Button
            className="h-11 shrink-0 rounded-button px-4 text-subhead font-medium"
            onClick={onOpen}
            variant="outline"
          >
            Look at it
          </Button>
        </div>
      ) : null}
    </li>
  );
}
