import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Backup, BackupStatus } from '@platter/shared';
import { formatBytes, formatCount, formatDuration, formatRelativeTime } from '@platter/shared';
import { Archive } from 'pixelarticons/react/Archive.js';
import { Download } from 'pixelarticons/react/Download.js';
import { Lock } from 'pixelarticons/react/Lock.js';
import { MoreVertical } from 'pixelarticons/react/MoreVertical.js';
import { Reload } from 'pixelarticons/react/Reload.js';
import { Unlock } from 'pixelarticons/react/Unlock.js';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { PageBody } from '@/components/layout/page-header';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useBackups,
  useCreateBackup,
  useDeleteBackup,
  useDownloadBackup,
  useLockBackup,
  useRestoreBackup,
} from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';
import { useServerScope } from './ServerLayout';
import { cn } from '@/lib/utils';

/**
 * Backups.
 *
 * The screen exists for one moment: the one where someone's world is broken and they need the
 * version from before. Two things follow from that.
 *
 * **Restore never asks "are you sure".** It spells out, in the dialog, exactly what happens to
 * the data that is on the volume right now — including that the server stops first, and that
 * the default merges rather than wipes. Getting that wrong costs a world.
 *
 * **An in-flight backup shows real numbers.** The API has no percentage to give — a `tar` of
 * an unknown-size tree cannot honestly report one — so this shows the phase and a live elapsed
 * clock instead of inventing a bar that creeps to 90% and stops. It also polls while anything
 * is moving, so "Completed" appears on its own rather than after a manual refresh.
 */

const ACTION = 'h-11 rounded-button px-4 text-subhead font-medium';

/** How often to re-read the list while a backup is building or restoring. */
const ACTIVE_POLL_MS = 3000;

const IN_FLIGHT: readonly BackupStatus[] = ['pending', 'running', 'restoring'];

const STATUS_COPY: Record<BackupStatus, { label: string; hint: string }> = {
  pending: { label: 'Queued', hint: 'Waiting for a slot. Only one backup runs at a time.' },
  running: { label: 'Archiving', hint: 'Reading the volume and writing a compressed archive.' },
  completed: { label: 'Ready', hint: 'Verified and ready to restore or download.' },
  failed: { label: 'Failed', hint: 'The archive was not written. Nothing on the volume changed.' },
  restoring: { label: 'Restoring', hint: 'Unpacking this archive back onto the volume.' },
};

const STATUS_TONE: Record<BackupStatus, string> = {
  pending: 'text-warning',
  running: 'text-warning',
  completed: 'text-success',
  failed: 'text-danger',
  restoring: 'text-warning',
};

const DOT_TONE: Record<BackupStatus, string> = {
  pending: 'bg-warning-dot',
  running: 'bg-warning-dot status-pulse',
  completed: 'bg-success-dot',
  failed: 'bg-danger-dot ring-2 ring-danger/30',
  restoring: 'bg-warning-dot status-pulse',
};

// ---------------------------------------------------------------------------------------

/** A clock that ticks once a second, only while something is actually running. */
function useElapsedSeconds(since: string, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const started = new Date(since).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}

// ---------------------------------------------------------------------------------------

export function BackupsPage() {
  const { server } = useServerScope();
  const queryClient = useQueryClient();

  const backups = useBackups(server.id);
  const create = useCreateBackup(server.id);
  const lock = useLockBackup(server.id);
  const remove = useDeleteBackup(server.id);
  const download = useDownloadBackup(server.id);
  const restore = useRestoreBackup(server.id);

  const [name, setName] = useState('');
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [deleting, setDeleting] = useState<Backup | null>(null);

  const rows = useMemo(
    () =>
      [...(backups.data?.data ?? [])].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      ),
    [backups.data],
  );

  const active = rows.filter((backup) => IN_FLIGHT.includes(backup.status));

  /*
   * `useBackups` has no interval of its own — polling every list in the app forever would be
   * wasteful — so the page drives it, and only while something is in flight. Invalidating
   * rather than refetching keeps every other consumer of this key in step.
   */
  const activeCount = active.length;
  useEffect(() => {
    if (activeCount === 0) return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups.all(server.id) });
    }, ACTIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeCount, queryClient, server.id]);

  const totalBytes = rows.reduce((sum, backup) => sum + (backup.sizeBytes ?? 0), 0);

  return (
    <PageBody className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-title-3 font-semibold text-label">Backups</h2>
          <p className="max-w-prose text-subhead text-label-secondary">
            A backup is a compressed archive of the whole data volume, taken while the server keeps
            running. Restoring one stops the server first.
          </p>
        </div>

        <form
          className="flex flex-wrap items-end gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              { name: name.trim() || undefined, ignore: [], locked: false },
              {
                onSuccess: () => {
                  setName('');
                  toast.create({
                    title: 'Backup started',
                    description: 'It builds in the background. This list updates as it goes.',
                    type: 'success',
                  });
                },
                onError: (cause: unknown) =>
                  toast.create({
                    title: 'Couldn’t start the backup',
                    description: errorMessage(cause),
                    type: 'error',
                  }),
              },
            );
          }}
        >
          <Field className="max-w-xs flex-1">
            <FieldLabel>Name this backup</FieldLabel>
            <Input
              className="h-11"
              maxLength={80}
              name="backupName"
              onChange={(event) => setName(event.target.value)}
              placeholder="Before the 1.21 update"
              value={name}
            />
            <FieldHelper>
              Optional. Left blank, it is named after the time it was taken.
            </FieldHelper>
          </Field>
          <Button
            {...(server.status === 'deleting' ? { 'aria-describedby': 'backup-create-hint' } : {})}
            className="h-11 rounded-button px-5 text-subhead font-medium"
            disabled={server.status === 'deleting'}
            isLoading={create.isPending}
            size="lg"
            type="submit"
          >
            <Archive aria-hidden />
            Take a backup
          </Button>
          {server.status === 'deleting' ? (
            <p className="text-caption text-label-tertiary" id="backup-create-hint">
              This server is being deleted, so there is nothing left to archive.
            </p>
          ) : null}
        </form>
      </section>

      <section className="flex flex-col gap-3">
        {backups.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-20 rounded-md" />
            <Skeleton className="h-20 rounded-md" />
            <span className="sr-only" role="status">
              Loading backups.
            </span>
          </div>
        ) : null}

        {backups.isError ? (
          <ErrorState
            error={backups.error}
            onRetry={() => void backups.refetch()}
            title="Couldn’t list the backups"
            variant="inline"
          />
        ) : null}

        {backups.isSuccess && rows.length === 0 ? (
          <EmptyState
            description="A backup captures the whole data volume — world, config, mods and plugins — as one archive you can put back later. Take one before every update; it is the only thing that undoes a bad one."
            icon={<Archive />}
            size="sm"
            title="No backups yet"
          />
        ) : null}

        {rows.length > 0 ? (
          <>
            <ul className="flex flex-col divide-y divide-separator border-y border-separator">
              {rows.map((backup) => (
                <BackupRow
                  backup={backup}
                  downloadPending={download.isPending && download.variables === backup.id}
                  key={backup.id}
                  lockPending={lock.isPending && lock.variables?.backupId === backup.id}
                  onDelete={() => setDeleting(backup)}
                  onDownload={() =>
                    download.mutate(backup.id, {
                      onError: (cause: unknown) =>
                        toast.create({
                          title: 'Couldn’t download it',
                          description: errorMessage(cause),
                          type: 'error',
                        }),
                    })
                  }
                  onRestore={() => setRestoring(backup)}
                  onToggleLock={() =>
                    lock.mutate(
                      { backupId: backup.id, locked: !backup.locked },
                      {
                        onError: (cause: unknown) =>
                          toast.create({
                            title: 'Couldn’t change the lock',
                            description: errorMessage(cause),
                            type: 'error',
                          }),
                      },
                    )
                  }
                  serverBusy={server.status === 'deleting'}
                />
              ))}
            </ul>

            <p className="tabular font-mono text-caption text-label-tertiary">
              {formatCount(rows.length, 'backup')}
              {totalBytes > 0 ? ` · ${formatBytes(totalBytes)} on disk` : null}
              {rows.some((backup) => backup.locked)
                ? ` · ${rows.filter((backup) => backup.locked).length} locked against rotation`
                : null}
            </p>
          </>
        ) : null}
      </section>

      <RestoreDialog
        backup={restoring}
        isPending={restore.isPending}
        onClose={() => setRestoring(null)}
        onConfirm={(truncate) => {
          if (!restoring) return;
          restore.mutate(
            { backupId: restoring.id, truncate },
            {
              onSuccess: (result) => {
                setRestoring(null);
                toast.create({
                  title: `Restored ${restoring.name}`,
                  description: result.stoppedServer
                    ? 'The server was stopped for the restore. Start it again when you are ready.'
                    : 'The server was already stopped, so nothing was interrupted.',
                  type: 'success',
                });
              },
              onError: (cause: unknown) =>
                toast.create({
                  title: 'The restore did not run',
                  description: errorMessage(cause),
                  type: 'error',
                }),
            },
          );
        }}
        serverName={server.name}
      />

      <DeleteDialog
        backup={deleting}
        isPending={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
              toast.create({ title: `Deleted ${deleting.name}`, type: 'success' });
            },
            onError: (cause: unknown) =>
              toast.create({
                title: 'Couldn’t delete it',
                description: errorMessage(cause),
                type: 'error',
              }),
          });
        }}
      />
    </PageBody>
  );
}

// ---------------------------------------------------------------------------------------

interface BackupRowProps {
  backup: Backup;
  serverBusy: boolean;
  lockPending: boolean;
  downloadPending: boolean;
  onToggleLock: () => void;
  onDownload: () => void;
  onRestore: () => void;
  onDelete: () => void;
}

function BackupRow({
  backup,
  serverBusy,
  lockPending,
  downloadPending,
  onToggleLock,
  onDownload,
  onRestore,
  onDelete,
}: BackupRowProps) {
  const inFlight = IN_FLIGHT.includes(backup.status);
  const elapsed = useElapsedSeconds(backup.createdAt, inFlight);
  const copy = STATUS_COPY[backup.status];

  const lockReason = backup.locked
    ? 'This backup is locked. Unlock it before it can be deleted or rotated out.'
    : null;
  const restoreReason =
    backup.status !== 'completed'
      ? `Only a finished backup can be restored. This one is ${copy.label.toLowerCase()}.`
      : serverBusy
        ? 'This server is being deleted, so there is nothing to restore onto.'
        : null;

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="min-w-0 truncate text-subhead font-medium text-label"
            title={backup.name}
          >
            {backup.name}
          </span>
          {backup.locked ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-secondary">
                  <Lock aria-hidden className="size-3" />
                  Locked
                </span>
              </TooltipTrigger>
              <TooltipContent>{lockReason}</TooltipContent>
            </Tooltip>
          ) : null}
          {backup.automatic ? (
            <span className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-tertiary">
              From a schedule
            </span>
          ) : null}
        </div>

        <p className="tabular flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-caption text-label-tertiary">
          <span className={cn('inline-flex items-center gap-1.5', STATUS_TONE[backup.status])}>
            <span aria-hidden className={cn('size-2 rounded-full', DOT_TONE[backup.status])} />
            {copy.label}
          </span>
          <span aria-hidden>·</span>
          <time dateTime={backup.createdAt} title={new Date(backup.createdAt).toLocaleString()}>
            {formatRelativeTime(backup.createdAt)}
          </time>
          {backup.sizeBytes !== null ? (
            <>
              <span aria-hidden>·</span>
              <span>{formatBytes(backup.sizeBytes)}</span>
            </>
          ) : null}
        </p>

        {inFlight ? (
          <div className="flex max-w-md flex-col gap-1.5">
            {/*
              Indeterminate on purpose. `tar` over a tree of unknown size cannot report a
              percentage, and a bar that pretends otherwise is the lie this product avoids —
              so the honest signal is the phase plus a clock that is visibly moving.
            */}
            <Progress
              aria-label={`${backup.name}: ${copy.label.toLowerCase()}`}
              className="gap-0"
              indeterminate
            />
            <p aria-live="polite" className="text-caption text-label-secondary" role="status">
              {copy.hint}{' '}
              <span className="tabular font-mono">{formatDuration(elapsed)} elapsed.</span>
            </p>
          </div>
        ) : null}

        {backup.status === 'failed' && backup.error ? (
          <p className="max-w-prose text-caption text-danger">{backup.error}</p>
        ) : null}

        {backup.status === 'completed' && backup.checksum ? (
          <p className="font-mono text-caption-2 text-label-quaternary">
            SHA-256 {backup.checksum.slice(0, 16)}… — verified before any restore.
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {restoreReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={`Restore — unavailable. ${restoreReason}`}
                className="inline-flex"
                tabIndex={0}
              >
                <span aria-hidden className="contents">
                  <Button className={ACTION} disabled variant="outline">
                    <Reload aria-hidden />
                    Restore
                  </Button>
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-pretty">{restoreReason}</TooltipContent>
          </Tooltip>
        ) : (
          <Button className={ACTION} onClick={onRestore} variant="outline">
            <Reload aria-hidden />
            Restore
          </Button>
        )}

        <Menu>
          <MenuTrigger asChild>
            <Button
              aria-label={`More actions for ${backup.name}`}
              className="hit-target size-11 text-label-tertiary hover:text-label"
              size="icon-lg"
              variant="ghost"
            >
              <MoreVertical aria-hidden />
            </Button>
          </MenuTrigger>
          <MenuContent className="w-60">
            <MenuItem
              disabled={backup.status !== 'completed' || downloadPending}
              onClick={onDownload}
              value="download"
            >
              <Download aria-hidden />
              {backup.status === 'completed'
                ? downloadPending
                  ? 'Preparing the download…'
                  : 'Download the archive'
                : 'Download (not finished yet)'}
            </MenuItem>
            <MenuItem disabled={lockPending} onClick={onToggleLock} value="lock">
              {backup.locked ? <Unlock aria-hidden /> : <Lock aria-hidden />}
              {backup.locked ? 'Unlock' : 'Lock against rotation'}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              disabled={backup.locked || backup.status === 'restoring'}
              onClick={onDelete}
              value="delete"
              variant="destructive"
            >
              {backup.locked ? 'Delete (unlock it first)' : 'Delete backup'}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------------

function RestoreDialog({
  backup,
  serverName,
  isPending,
  onClose,
  onConfirm,
}: {
  backup: Backup | null;
  serverName: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (truncate: boolean) => void;
}) {
  const [truncate, setTruncate] = useState(false);
  useEffect(() => setTruncate(false), [backup]);

  return (
    <AlertDialog onOpenChange={({ open }) => (open ? undefined : onClose())} open={backup !== null}>
      <AlertDialogContent size="md">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-sans text-title-3 font-semibold">
            Restore {backup?.name} onto {serverName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {backup ? (
              <>
                This archive was taken {formatRelativeTime(backup.createdAt)}
                {backup.sizeBytes !== null ? ` and holds ${formatBytes(backup.sizeBytes)}` : ''}.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogBody className="flex flex-col gap-4 text-subhead text-label-secondary">
          <ol className="flex list-decimal flex-col gap-2 ps-5">
            <li>
              <strong className="font-medium text-label">{serverName} is stopped</strong> if it is
              running. Players are disconnected without warning.
            </li>
            <li>
              The archive is checksum-verified, then unpacked over the data volume. Every file in
              the archive <strong className="font-medium text-label">overwrites</strong> the copy on
              disk.
            </li>
            <li>
              The server stays stopped afterwards. Nothing starts it for you, so you can look before
              you go live.
            </li>
          </ol>

          <div className="flex flex-col gap-3 rounded-md border border-separator-strong p-3">
            <div className="flex items-start gap-3">
              <Checkbox
                aria-describedby="restore-truncate-help"
                checked={truncate}
                className="hit-target mt-0.5"
                id="restore-truncate"
                onCheckedChange={({ checked }) => setTruncate(checked === true)}
              />
              <div className="flex flex-col gap-1">
                <label className="text-subhead font-medium text-label" htmlFor="restore-truncate">
                  Wipe the volume first
                </label>
                <p className="text-caption text-label-secondary" id="restore-truncate-help">
                  {truncate
                    ? 'Everything currently on the volume is deleted before the archive is unpacked. Files added since this backup — new mods, new worlds, new logs — are gone.'
                    : 'Left off, the archive is merged in: files it contains are overwritten, and anything added since the backup is left alone. This is the safer choice and the default.'}
                </p>
              </div>
            </div>
          </div>

          {truncate ? (
            <p
              className="rounded-sm border border-danger/25 bg-danger-subtle px-3 py-2 text-subhead text-danger"
              role="alert"
            >
              With the wipe on, anything on this volume that is not in {backup?.name} is permanently
              deleted. There is no second copy.
            </p>
          ) : null}
        </AlertDialogBody>

        <AlertDialogFooter>
          <AlertDialogCancel className={ACTION}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={ACTION}
            isLoading={isPending}
            onClick={() => onConfirm(truncate)}
            variant="destructive"
          >
            {truncate ? 'Wipe and restore' : 'Stop the server and restore'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteDialog({
  backup,
  isPending,
  onClose,
  onConfirm,
}: {
  backup: Backup | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog onOpenChange={({ open }) => (open ? undefined : onClose())} open={backup !== null}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-sans text-title-3 font-semibold">
            Delete {backup?.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {backup ? (
              <>
                Taken {formatRelativeTime(backup.createdAt)}
                {backup.sizeBytes !== null ? `, ${formatBytes(backup.sizeBytes)}` : ''}. The archive
                is removed from disk and cannot be restored afterwards.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="text-subhead text-label-secondary">
          The server’s current files are untouched — this only removes the copy taken back then.
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel className={ACTION}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            className={ACTION}
            isLoading={isPending}
            onClick={onConfirm}
            variant="destructive"
          >
            Delete backup
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
