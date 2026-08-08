import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FileEntry } from '@platter/shared';
import { LIMITS, formatBytes, formatCount, formatRelativeTime } from '@platter/shared';
import { Archive } from 'pixelarticons/react/Archive.js';
import { ArrowDown } from 'pixelarticons/react/ArrowDown.js';
import { ArrowUp } from 'pixelarticons/react/ArrowUp.js';
import { Close } from 'pixelarticons/react/Close.js';
import { Download } from 'pixelarticons/react/Download.js';
import { File as FileIcon } from 'pixelarticons/react/File.js';
import { Folder } from 'pixelarticons/react/Folder.js';
import { FolderPlus } from 'pixelarticons/react/FolderPlus.js';
import { Image as ImageIcon } from 'pixelarticons/react/Image.js';
import { MoreVertical } from 'pixelarticons/react/MoreVertical.js';
import { Music } from 'pixelarticons/react/Music.js';
import { Notes } from 'pixelarticons/react/Notes.js';
import { Upload } from 'pixelarticons/react/Upload.js';
import { Video } from 'pixelarticons/react/Video.js';
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldHelper, FieldLabel } from '@/components/ui/field';
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadTrigger,
} from '@/components/ui/file-upload';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import {
  useCompressPaths,
  useCopyPath,
  useCreateDirectory,
  useDeletePaths,
  useDownloadFile,
  useExtractArchive,
  useFileList,
  useRenamePath,
  useWriteFile,
} from '@/hooks';
import { api, errorMessage } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';
import { cn } from '@/lib/utils';

/**
 * The file manager for one server's data volume.
 *
 * Paths here are the API's own: relative to the volume root, no leading slash, `''` being the
 * root itself. Nothing in this component invents a path shape the server would then reject.
 *
 * Uploads do not go through `useUploadFile`. That hook uses `fetch`, which reports no progress
 * at all — and a 900 MB world upload showing an indefinite spinner for four minutes is exactly
 * the "endless spinner" this product is meant not to ship. This uses `XMLHttpRequest` for the
 * one thing it still does better than `fetch`: a real `upload.onprogress`. The cache is
 * invalidated by hand afterwards, the same way the hook would have.
 */

const ACTION = 'h-11 rounded-button px-4 text-subhead font-medium';

/** Archives the API can actually extract. Anything else gets a disabled item with a reason. */
export const ARCHIVE_PATTERN = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;
const IMAGE_PATTERN = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const AUDIO_PATTERN = /\.(mp3|ogg|wav|flac|m4a)$/i;
const VIDEO_PATTERN = /\.(mp4|webm|mkv|mov)$/i;
const TEXT_PATTERN =
  /\.(txt|log|properties|ya?ml|json|toml|ini|cfg|conf|md|sh|env|lock|list|mcmeta)$/i;

const MAX_CONCURRENT_UPLOADS = 3;

type SortKey = 'name' | 'size' | 'modified';
type SortDirection = 'asc' | 'desc';

interface UploadTask {
  id: string;
  name: string;
  size: number;
  loaded: number;
  status: 'uploading' | 'done' | 'failed';
  error?: string;
  abort: () => void;
}

// ---------------------------------------------------------------------------------------
// Path helpers — the API's shape, not the browser's
// ---------------------------------------------------------------------------------------

function joinPath(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

function parentOf(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '' : filePath.slice(0, index);
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** `world.tar.gz` -> `world (copy).tar.gz`; `server` -> `server (copy)`. */
function duplicateName(name: string): string {
  const compound = /\.(tar\.gz|tar\.bz2|tar\.xz)$/i.exec(name);
  if (compound) return `${name.slice(0, compound.index)} (copy)${compound[0]}`;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (copy)`;
  return `${name.slice(0, dot)} (copy)${name.slice(dot)}`;
}

function iconFor(entry: FileEntry) {
  if (entry.type === 'directory') return Folder;
  if (ARCHIVE_PATTERN.test(entry.name) || /\.(zip|jar|rar|7z)$/i.test(entry.name)) return Archive;
  if (IMAGE_PATTERN.test(entry.name)) return ImageIcon;
  if (AUDIO_PATTERN.test(entry.name)) return Music;
  if (VIDEO_PATTERN.test(entry.name)) return Video;
  if (TEXT_PATTERN.test(entry.name)) return Notes;
  return FileIcon;
}

/**
 * Whether the text editor can open this. The API's own `editable` flag is authoritative —
 * it has seen the bytes — and the extension list is only a fallback for entries where the
 * driver could not decide.
 */
export function isEditable(entry: FileEntry): boolean {
  if (entry.type !== 'file') return false;
  return entry.editable || TEXT_PATTERN.test(entry.name);
}

// ---------------------------------------------------------------------------------------
// Upload transport
// ---------------------------------------------------------------------------------------

interface UploadHandle {
  promise: Promise<void>;
  abort: () => void;
}

function uploadFile(
  serverId: string,
  directory: string,
  file: File,
  onProgress: (loaded: number) => void,
): UploadHandle {
  const request = new XMLHttpRequest();
  const promise = new Promise<void>((resolve, reject) => {
    const body = new FormData();
    body.append('file', file);

    request.open('POST', api.url(`/servers/${serverId}/files/upload`, { path: directory }));
    request.withCredentials = true;
    const token = api.accessToken;
    if (token) request.setRequestHeader('authorization', `Bearer ${token}`);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(file.size);
        resolve();
        return;
      }
      // The API answers with its standard error envelope; surface its message, not the status.
      let message = `The server refused the upload (HTTP ${request.status}).`;
      try {
        const parsed: unknown = JSON.parse(request.responseText);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'error' in parsed &&
          typeof (parsed as { error: { message?: unknown } }).error.message === 'string'
        ) {
          message = (parsed as { error: { message: string } }).error.message;
        }
      } catch {
        // Not JSON — a proxy or gateway answered. The status-derived message stands.
      }
      reject(new Error(message));
    });
    request.addEventListener('error', () =>
      reject(new Error('The connection dropped before the upload finished.')),
    );
    request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    request.send(body);
  });

  return { promise, abort: () => request.abort() };
}

// ---------------------------------------------------------------------------------------

export interface FileBrowserProps {
  serverId: string;
  serverName: string;
  /** The folder being shown. `''` is the volume root. */
  path: string;
  onNavigate: (path: string) => void;
  /** Opens a file in the editor. Only called for entries the editor can handle. */
  onOpenFile: (entry: FileEntry) => void;
  canWrite: boolean;
  canDelete: boolean;
  className?: string;
}

export function FileBrowser({
  serverId,
  serverName,
  path,
  onNavigate,
  onOpenFile,
  canWrite,
  canDelete,
  className,
}: FileBrowserProps) {
  const queryClient = useQueryClient();
  const listing = useFileList(serverId, path);

  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'name',
    direction: 'asc',
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [uploads, setUploads] = useState<UploadTask[]>([]);

  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
  const [deleting, setDeleting] = useState<FileEntry[] | null>(null);

  const rename = useRenamePath(serverId);
  const createDirectory = useCreateDirectory(serverId);
  const writeFile = useWriteFile(serverId);
  const deletePaths = useDeletePaths(serverId);
  const compress = useCompressPaths(serverId);
  const extract = useExtractArchive(serverId);
  const copyPath = useCopyPath(serverId);
  const downloadFile = useDownloadFile(serverId);

  // A selection is a set of paths in *this* folder. Carrying it across a navigation would
  // let a Delete press act on rows that are no longer on screen.
  useEffect(() => setSelected(new Set()), [path]);

  const entries = useMemo(() => {
    const rows = [...(listing.data?.entries ?? [])];
    const factor = sort.direction === 'asc' ? 1 : -1;
    rows.sort((left, right) => {
      // Folders first regardless of the sort — every file manager does this, and mixing
      // them makes a large folder impossible to scan.
      if (left.type !== right.type) {
        if (left.type === 'directory') return -1;
        if (right.type === 'directory') return 1;
      }
      if (sort.key === 'size') return (left.sizeBytes - right.sizeBytes) * factor;
      if (sort.key === 'modified') {
        return (
          (new Date(left.modifiedAt).getTime() - new Date(right.modifiedAt).getTime()) * factor
        );
      }
      return left.name.localeCompare(right.name, undefined, { numeric: true }) * factor;
    });
    return rows;
  }, [listing.data, sort]);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.path)),
    [entries, selected],
  );

  const toggleSort = useCallback((key: SortKey) => {
    setSort((previous) =>
      previous.key === key
        ? { key, direction: previous.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'name' ? 'asc' : 'desc' },
    );
  }, []);

  const toggleSelection = useCallback((entryPath: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(entryPath);
      else next.delete(entryPath);
      return next;
    });
  }, []);

  // -- uploads ---------------------------------------------------------------------------

  const queueRef = useRef<Array<() => void>>([]);
  const activeRef = useRef(0);

  const pump = useCallback(() => {
    while (activeRef.current < MAX_CONCURRENT_UPLOADS && queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (!next) break;
      activeRef.current += 1;
      next();
    }
  }, []);

  const startUploads = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (!api.accessToken) {
        toast.create({
          title: 'Upload not started',
          description: 'Your session is being refreshed. Try the upload again in a moment.',
          type: 'error',
        });
        return;
      }

      for (const file of files) {
        const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const run = () => {
          const handle = uploadFile(serverId, path, file, (loaded) => {
            setUploads((previous) =>
              previous.map((task) => (task.id === id ? { ...task, loaded } : task)),
            );
          });

          setUploads((previous) =>
            previous.map((task) => (task.id === id ? { ...task, abort: handle.abort } : task)),
          );

          handle.promise
            .then(() => {
              setUploads((previous) =>
                previous.map((task) =>
                  task.id === id ? { ...task, status: 'done', loaded: file.size } : task,
                ),
              );
              void queryClient.invalidateQueries({ queryKey: queryKeys.files.list(serverId, path) });
            })
            .catch((cause: unknown) => {
              setUploads((previous) =>
                previous.map((task) =>
                  task.id === id
                    ? { ...task, status: 'failed', error: errorMessage(cause) }
                    : task,
                ),
              );
            })
            .finally(() => {
              activeRef.current -= 1;
              pump();
            });
        };

        setUploads((previous) => [
          ...previous,
          {
            id,
            name: file.name,
            size: file.size,
            loaded: 0,
            status: 'uploading',
            abort: () => undefined,
          },
        ]);
        queueRef.current.push(run);
      }
      pump();
    },
    [path, pump, queryClient, serverId],
  );

  const activeUploads = uploads.filter((task) => task.status === 'uploading');

  // -- mutations with shared feedback ----------------------------------------------------

  /**
   * Runs a mutation and reports the outcome, both to the person and to the caller. The
   * boolean matters: a dialog that closes on a failed rename throws away what was typed, and
   * a selection cleared after a failed compress hides the rows the retry needs.
   */
  const runAction = useCallback(
    async (label: string, action: () => Promise<unknown>, success: string): Promise<boolean> => {
      try {
        await action();
        toast.create({ title: success, type: 'success' });
        return true;
      } catch (cause: unknown) {
        toast.create({ title: label, description: errorMessage(cause), type: 'error' });
        return false;
      }
    },
    [],
  );

  // -- render ----------------------------------------------------------------------------

  if (listing.isError) {
    return (
      <ErrorState
        error={listing.error}
        onRetry={() => void listing.refetch()}
        title="Couldn’t read that folder"
        variant="inline"
      />
    );
  }

  const allSelected = entries.length > 0 && selected.size === entries.length;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <PathBreadcrumbs onNavigate={onNavigate} path={path} serverName={serverName} />

      {/* ---- toolbar ---- */}
      <FileUpload
        allowDrop={canWrite}
        className="gap-3"
        maxFileSize={LIMITS.maxUploadBytes}
        maxFiles={50}
        onFileAccept={({ files }) => startUploads(files)}
        onFileReject={({ files }) => {
          for (const rejection of files) {
            toast.create({
              title: `${rejection.file.name} was not uploaded`,
              description: rejection.errors.includes('FILE_TOO_LARGE')
                ? `It is larger than the ${formatBytes(LIMITS.maxUploadBytes)} upload limit. Compress it first, or copy it onto the volume from the host.`
                : 'That file is not accepted here.',
              type: 'error',
            });
          }
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className={ACTION}
            disabled={!canWrite}
            onClick={() => setCreating('folder')}
            variant="outline"
            {...(canWrite ? {} : { 'aria-describedby': 'files-readonly-hint' })}
          >
            <FolderPlus aria-hidden />
            New folder
          </Button>
          <Button
            className={ACTION}
            disabled={!canWrite}
            onClick={() => setCreating('file')}
            variant="outline"
            {...(canWrite ? {} : { 'aria-describedby': 'files-readonly-hint' })}
          >
            <FileIcon aria-hidden />
            New file
          </Button>
          <FileUploadTrigger asChild>
            <Button className={ACTION} disabled={!canWrite} variant="outline">
              <Upload aria-hidden />
              Upload
            </Button>
          </FileUploadTrigger>

          {!canWrite ? (
            <p className="text-caption text-label-tertiary" id="files-readonly-hint">
              You can read these files but not change them. Ask the owner for the files.write
              permission.
            </p>
          ) : null}
        </div>

        {/*
          The whole listing is the drop target, with the click behaviour turned off — a
          click anywhere in a file list opening an OS file picker would be unusable. The
          Upload button above is the click path.
        */}
        <FileUploadDropzone
          className={cn(
            'block cursor-default rounded-md border-separator-strong p-0 text-start',
            'data-dragging:border-primary data-dragging:bg-accent-subtle',
          )}
          disableClick
        >
          {listing.isPending ? (
            <ListingSkeleton />
          ) : entries.length === 0 ? (
            <EmptyState
              description={
                canWrite
                  ? 'Drop files onto this panel to upload them, or make a folder to start organising. Everything here lives on the server’s data volume.'
                  : 'This folder is empty.'
              }
              icon={<Folder />}
              size="sm"
              title={path === '' ? 'The volume is empty' : 'Nothing in this folder'}
            />
          ) : (
            <>
              {/* Desktop: a real table, sortable by column header. */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12 ps-3">
                        <Checkbox
                          aria-label={
                            allSelected ? 'Clear the selection' : 'Select everything in this folder'
                          }
                          checked={
                            allSelected ? true : selected.size > 0 ? 'indeterminate' : false
                          }
                          className="hit-target"
                          onCheckedChange={({ checked }) =>
                            setSelected(
                              checked === true ? new Set(entries.map((row) => row.path)) : new Set(),
                            )
                          }
                        />
                      </TableHead>
                      <SortableHead
                        current={sort}
                        label="Name"
                        onSort={toggleSort}
                        sortKey="name"
                      />
                      <SortableHead
                        className="w-32"
                        current={sort}
                        label="Size"
                        onSort={toggleSort}
                        sortKey="size"
                      />
                      <SortableHead
                        className="w-44"
                        current={sort}
                        label="Modified"
                        onSort={toggleSort}
                        sortKey="modified"
                      />
                      <TableHead className="w-16 text-end">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry) => (
                      <FileRow
                        canDelete={canDelete}
                        canWrite={canWrite}
                        compress={compress}
                        copyPath={copyPath}
                        downloadFile={downloadFile}
                        entry={entry}
                        extract={extract}
                        key={entry.path}
                        onDelete={() => setDeleting([entry])}
                        onNavigate={onNavigate}
                        onOpenFile={onOpenFile}
                        onRename={() => setRenaming(entry)}
                        onToggle={toggleSelection}
                        runAction={runAction}
                        selected={selected.has(entry.path)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Phone: the same rows as cards. A five-column table at 360px is unreadable. */}
              <ul className="divide-y divide-separator md:hidden">
                {entries.map((entry) => (
                  <FileCard
                    canDelete={canDelete}
                    canWrite={canWrite}
                    compress={compress}
                    copyPath={copyPath}
                    downloadFile={downloadFile}
                    entry={entry}
                    extract={extract}
                    key={entry.path}
                    onDelete={() => setDeleting([entry])}
                    onNavigate={onNavigate}
                    onOpenFile={onOpenFile}
                    onRename={() => setRenaming(entry)}
                    onToggle={toggleSelection}
                    runAction={runAction}
                    selected={selected.has(entry.path)}
                  />
                ))}
              </ul>
            </>
          )}
        </FileUploadDropzone>
      </FileUpload>

      {/* ---- upload queue ---- */}
      {uploads.length > 0 ? (
        <section
          aria-label="Uploads"
          className="flex flex-col gap-2 rounded-md border border-separator-strong p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-sans text-subhead font-semibold text-label">
              {activeUploads.length > 0
                ? `Uploading ${formatCount(activeUploads.length, 'file')}`
                : 'Uploads'}
            </h3>
            <Button
              className="h-11 px-3 text-caption"
              onClick={() => setUploads((previous) => previous.filter((t) => t.status === 'uploading'))}
              variant="ghost"
            >
              Clear finished
            </Button>
          </div>
          <ul className="flex flex-col gap-3">
            {uploads.map((task) => {
              const percent = task.size > 0 ? Math.round((task.loaded / task.size) * 100) : 0;
              return (
                <li className="flex flex-col gap-1" key={task.id}>
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-footnote text-label" title={task.name}>
                      {task.name}
                    </span>
                    <span className="tabular shrink-0 font-mono text-caption text-label-tertiary">
                      {task.status === 'uploading'
                        ? `${formatBytes(task.loaded)} / ${formatBytes(task.size)}`
                        : task.status === 'done'
                          ? formatBytes(task.size)
                          : 'Failed'}
                    </span>
                    {task.status === 'uploading' ? (
                      <Button
                        aria-label={`Cancel uploading ${task.name}`}
                        className="hit-target size-8 shrink-0"
                        onClick={() => task.abort()}
                        size="icon-md"
                        variant="ghost"
                      >
                        <Close aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  {task.status === 'uploading' ? (
                    <Progress
                      aria-label={`${task.name} upload progress`}
                      className="gap-0"
                      max={100}
                      value={percent}
                    />
                  ) : null}
                  {task.status === 'failed' ? (
                    <p className="text-caption text-danger">{task.error}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p aria-live="polite" className="sr-only" role="status">
            {activeUploads.length === 0
              ? 'All uploads finished.'
              : `${activeUploads.length} uploads in progress.`}
          </p>
        </section>
      ) : null}

      {/* ---- selection action bar ---- */}
      {selected.size > 0 ? (
        <div
          className="sticky bottom-4 z-10 flex flex-wrap items-center gap-2 rounded-md border border-separator-strong bg-surface p-3 shadow-2"
          role="group"
          aria-label="Actions for the selected files"
        >
          <p className="me-auto text-subhead text-label">
            {formatCount(selected.size, 'item')} selected
          </p>
          <Button
            className={ACTION}
            disabled={!canWrite}
            isLoading={compress.isPending}
            onClick={() =>
              void runAction(
                'Couldn’t create the archive',
                () => compress.mutateAsync({ paths: [...selected] }),
                'Archive created in this folder',
              ).then((ok) => {
                if (ok) setSelected(new Set());
              })
            }
            variant="outline"
          >
            <Archive aria-hidden />
            Compress
          </Button>
          <Button
            className={ACTION}
            disabled={!canDelete}
            onClick={() => setDeleting(selectedEntries)}
            variant="outline"
            {...(canDelete ? {} : { 'aria-describedby': 'files-nodelete-hint' })}
          >
            Delete
          </Button>
          <Button className={ACTION} onClick={() => setSelected(new Set())} variant="ghost">
            Clear
          </Button>
          {!canDelete ? (
            <p className="basis-full text-caption text-label-tertiary" id="files-nodelete-hint">
              Deleting needs the files.delete permission.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---- dialogs ---- */}
      <RenameDialog
        entry={renaming}
        isPending={rename.isPending}
        onClose={() => setRenaming(null)}
        onSubmit={(nextName) => {
          if (!renaming) return;
          void runAction(
            'Couldn’t rename it',
            () => rename.mutateAsync({ from: renaming.path, to: joinPath(path, nextName) }),
            `Renamed to ${nextName}`,
          ).then((ok) => {
            if (ok) setRenaming(null);
          });
        }}
      />

      <CreateDialog
        existing={entries.map((entry) => entry.name)}
        isPending={createDirectory.isPending || writeFile.isPending}
        kind={creating}
        onClose={() => setCreating(null)}
        onSubmit={(name) => {
          const target = joinPath(path, name);
          if (creating === 'folder') {
            void runAction(
              'Couldn’t create the folder',
              () => createDirectory.mutateAsync(target),
              `Created ${name}`,
            ).then((ok) => {
              if (ok) setCreating(null);
            });
            return;
          }
          void runAction(
            'Couldn’t create the file',
            () => writeFile.mutateAsync({ path: target, content: '' }),
            `Created ${name}`,
          ).then((ok) => {
            if (ok) setCreating(null);
          });
        }}
      />

      <DeleteDialog
        entries={deleting}
        isPending={deletePaths.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const targets = deleting ?? [];
          void runAction(
            'Couldn’t delete that',
            () => deletePaths.mutateAsync(targets.map((entry) => entry.path)),
            `Deleted ${formatCount(targets.length, 'item')}`,
          ).then((ok) => {
            if (!ok) return;
            setDeleting(null);
            setSelected(new Set());
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------------------

/** More than this many folders deep and the middle collapses, so a long path cannot push
 *  the toolbar off screen on a phone. */
const BREADCRUMB_VISIBLE_TAIL = 2;

function PathBreadcrumbs({
  path,
  serverName,
  onNavigate,
}: {
  path: string;
  serverName: string;
  onNavigate: (path: string) => void;
}) {
  const segments = segmentsOf(path);
  const collapsed = segments.length > BREADCRUMB_VISIBLE_TAIL + 1;
  const hidden = collapsed ? segments.slice(0, segments.length - BREADCRUMB_VISIBLE_TAIL) : [];
  const shown = collapsed ? segments.slice(segments.length - BREADCRUMB_VISIBLE_TAIL) : segments;
  const hiddenOffset = hidden.length;

  return (
    <Breadcrumb aria-label="Folder path" className="min-w-0 overflow-x-auto">
      <BreadcrumbList className="flex-nowrap whitespace-nowrap">
        <BreadcrumbItem>
          <Button
            className="h-11 rounded-sm px-2 text-subhead text-label-secondary hover:text-label"
            onClick={() => onNavigate('')}
            variant="ghost"
          >
            <Folder aria-hidden />
            <span className="max-w-40 truncate">{serverName}</span>
          </Button>
        </BreadcrumbItem>

        {collapsed ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <Menu>
                <MenuTrigger asChild>
                  <Button
                    aria-label={`Show the ${hidden.length} folders in between`}
                    className="hit-target h-11 rounded-sm px-2 text-label-tertiary"
                    variant="ghost"
                  >
                    …
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {hidden.map((segment, index) => (
                    <MenuItem
                      key={segment + String(index)}
                      onClick={() => onNavigate(segments.slice(0, index + 1).join('/'))}
                      value={segment + String(index)}
                    >
                      <Folder aria-hidden />
                      {segment}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            </BreadcrumbItem>
          </>
        ) : null}

        {shown.map((segment, index) => {
          const absoluteIndex = hiddenOffset + index;
          const target = segments.slice(0, absoluteIndex + 1).join('/');
          const last = absoluteIndex === segments.length - 1;
          return (
            <BreadcrumbItem key={target}>
              <BreadcrumbSeparator />
              {last ? (
                <BreadcrumbPage className="max-w-56 truncate px-2 text-subhead" title={segment}>
                  {segment}
                </BreadcrumbPage>
              ) : (
                <Button
                  className="h-11 max-w-56 rounded-sm px-2 text-subhead text-label-secondary hover:text-label"
                  onClick={() => onNavigate(target)}
                  variant="ghost"
                >
                  <span className="truncate">{segment}</span>
                </Button>
              )}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

function SortableHead({
  label,
  sortKey,
  current,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  current: { key: SortKey; direction: SortDirection };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = current.key === sortKey;
  const Arrow = current.direction === 'asc' ? ArrowUp : ArrowDown;

  return (
    <TableHead
      aria-sort={active ? (current.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
    >
      <Button
        className="h-11 rounded-sm px-2 text-subhead font-medium text-label-secondary hover:text-label"
        onClick={() => onSort(sortKey)}
        variant="ghost"
      >
        {label}
        {active ? <Arrow aria-hidden /> : null}
      </Button>
    </TableHead>
  );
}

interface RowProps {
  entry: FileEntry;
  selected: boolean;
  canWrite: boolean;
  canDelete: boolean;
  onToggle: (path: string, checked: boolean) => void;
  onNavigate: (path: string) => void;
  onOpenFile: (entry: FileEntry) => void;
  onRename: () => void;
  onDelete: () => void;
  runAction: (label: string, action: () => Promise<unknown>, success: string) => Promise<boolean>;
  downloadFile: ReturnType<typeof useDownloadFile>;
  compress: ReturnType<typeof useCompressPaths>;
  extract: ReturnType<typeof useExtractArchive>;
  copyPath: ReturnType<typeof useCopyPath>;
}

/**
 * The per-row menu, used identically by the table row and the phone card and mirrored into a
 * right-click menu. It is a real button and not only a context menu, because a context menu
 * has no keyboard or touch equivalent.
 */
function RowActions({
  entry,
  canWrite,
  canDelete,
  onOpenFile,
  onRename,
  onDelete,
  runAction,
  downloadFile,
  compress,
  extract,
  copyPath,
  asContextMenu = false,
}: Omit<RowProps, 'selected' | 'onToggle' | 'onNavigate'> & { asContextMenu?: boolean }) {
  const editable = isEditable(entry);
  const archive = ARCHIVE_PATTERN.test(entry.name);
  const isDirectory = entry.type === 'directory';

  const items = (
    <>
      {editable ? (
        <MenuItem onClick={() => onOpenFile(entry)} value="edit">
          <Notes aria-hidden />
          Edit
        </MenuItem>
      ) : null}

      <MenuItem
        disabled={isDirectory}
        onClick={() => {
          if (isDirectory) return;
          void runAction(
            'Couldn’t download it',
            () => downloadFile.mutateAsync(entry.path),
            `Downloading ${entry.name}`,
          );
        }}
        value="download"
      >
        <Download aria-hidden />
        {isDirectory ? 'Download (compress it first)' : 'Download'}
      </MenuItem>

      <MenuItem disabled={!canWrite} onClick={onRename} value="rename">
        Rename
      </MenuItem>

      <MenuItem
        disabled={!canWrite}
        onClick={() =>
          void runAction(
            'Couldn’t duplicate it',
            () =>
              copyPath.mutateAsync({
                from: entry.path,
                to: joinPath(parentOf(entry.path), duplicateName(entry.name)),
              }),
            `Copied to ${duplicateName(entry.name)}`,
          )
        }
        value="duplicate"
      >
        Duplicate
      </MenuItem>

      <MenuSeparator />

      <MenuItem
        disabled={!canWrite}
        onClick={() =>
          void runAction(
            'Couldn’t create the archive',
            () => compress.mutateAsync({ paths: [entry.path] }),
            `Compressed ${entry.name}`,
          )
        }
        value="compress"
      >
        <Archive aria-hidden />
        Compress
      </MenuItem>

      <MenuItem
        disabled={!canWrite || !archive}
        onClick={() => {
          if (!archive) return;
          void runAction(
            'Couldn’t extract it',
            () => extract.mutateAsync({ path: entry.path, destination: parentOf(entry.path) }),
            `Extracted ${entry.name} here`,
          );
        }}
        value="extract"
      >
        {archive ? 'Extract here' : 'Extract (not an archive)'}
      </MenuItem>

      <MenuSeparator />

      <MenuItem disabled={!canDelete} onClick={onDelete} value="delete" variant="destructive">
        Delete
      </MenuItem>
    </>
  );

  if (asContextMenu) {
    return <ContextMenuContent className="w-56">{items}</ContextMenuContent>;
  }

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          aria-label={`Actions for ${entry.name}`}
          className="hit-target size-11 text-label-tertiary hover:text-label"
          size="icon-lg"
          variant="ghost"
        >
          <MoreVertical aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent className="w-56">{items}</MenuContent>
    </Menu>
  );
}

function OpenControl({
  entry,
  onNavigate,
  onOpenFile,
  className,
}: {
  entry: FileEntry;
  onNavigate: (path: string) => void;
  onOpenFile: (entry: FileEntry) => void;
  className?: string;
}) {
  const Icon = iconFor(entry);
  const openable = entry.type === 'directory' || isEditable(entry);

  const content = (
    <>
      <Icon
        aria-hidden
        className={cn('size-4 shrink-0', entry.type === 'directory' ? 'text-label' : 'text-label-tertiary')}
      />
      <span className="truncate">{entry.name}</span>
    </>
  );

  if (!openable) {
    return (
      <span
        className={cn('flex min-w-0 items-center gap-2 py-2 text-subhead text-label', className)}
        title={entry.name}
      >
        {content}
        <span className="sr-only">
          {entry.type === 'symlink' ? ' — symbolic link' : ' — not a text file'}
        </span>
      </span>
    );
  }

  return (
    <Button
      className={cn(
        'h-11 min-w-0 justify-start gap-2 rounded-sm px-2 text-subhead font-normal text-label',
        className,
      )}
      onClick={() => (entry.type === 'directory' ? onNavigate(entry.path) : onOpenFile(entry))}
      title={entry.name}
      variant="ghost"
    >
      {content}
    </Button>
  );
}

function FileRow(props: RowProps) {
  const { entry, selected, onToggle, onNavigate, onOpenFile } = props;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableRow data-state={selected ? 'selected' : undefined}>
          <TableCell className="ps-3">
            <Checkbox
              aria-label={`Select ${entry.name}`}
              checked={selected}
              className="hit-target"
              onCheckedChange={({ checked }) => onToggle(entry.path, checked === true)}
            />
          </TableCell>
          <TableCell className="max-w-0">
            <OpenControl entry={entry} onNavigate={onNavigate} onOpenFile={onOpenFile} />
          </TableCell>
          <TableCell className="tabular font-mono text-caption text-label-tertiary">
            {entry.type === 'directory' ? '—' : formatBytes(entry.sizeBytes)}
          </TableCell>
          <TableCell className="text-caption text-label-tertiary">
            <time dateTime={entry.modifiedAt} title={new Date(entry.modifiedAt).toLocaleString()}>
              {formatRelativeTime(entry.modifiedAt)}
            </time>
          </TableCell>
          <TableCell className="text-end">
            <RowActions {...props} />
          </TableCell>
        </TableRow>
      </ContextMenuTrigger>
      <RowActions {...props} asContextMenu />
    </ContextMenu>
  );
}

function FileCard(props: RowProps) {
  const { entry, selected, onToggle, onNavigate, onOpenFile } = props;

  return (
    <li className="flex items-center gap-2 px-2 py-1">
      <Checkbox
        aria-label={`Select ${entry.name}`}
        checked={selected}
        className="hit-target ms-1"
        onCheckedChange={({ checked }) => onToggle(entry.path, checked === true)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <OpenControl
          className="w-full"
          entry={entry}
          onNavigate={onNavigate}
          onOpenFile={onOpenFile}
        />
        <p className="tabular ps-2 font-mono text-caption text-label-tertiary">
          {entry.type === 'directory' ? 'Folder' : formatBytes(entry.sizeBytes)}
          {' · '}
          <time dateTime={entry.modifiedAt} title={new Date(entry.modifiedAt).toLocaleString()}>
            {formatRelativeTime(entry.modifiedAt)}
          </time>
        </p>
      </div>
      <RowActions {...props} />
    </li>
  );
}

function ListingSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <Skeleton className="h-11 rounded-sm" key={index} />
      ))}
      <span className="sr-only" role="status">
        Reading the folder.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------

/** Characters the API's path schema rejects, checked here so the dialog can say so first. */
function nameProblem(name: string, existing: readonly string[] = []): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Give it a name.';
  if (trimmed === '.' || trimmed === '..') return 'That name is reserved by the filesystem.';
  if (trimmed.includes('/')) return 'A name cannot contain a slash. Use New folder to nest it.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return 'A name cannot contain control characters.';
  if (existing.includes(trimmed)) return 'Something here already has that name.';
  return null;
}

function RenameDialog({
  entry,
  isPending,
  onClose,
  onSubmit,
}: {
  entry: FileEntry | null;
  isPending: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState('');
  useEffect(() => setName(entry?.name ?? ''), [entry]);

  const problem = entry ? nameProblem(name) : null;

  return (
    <Dialog onOpenChange={({ open }) => (open ? undefined : onClose())} open={entry !== null}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="font-sans text-title-3 font-semibold">
            Rename {entry?.name}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="rename-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!problem) onSubmit(name.trim());
            }}
          >
            <Field invalid={Boolean(problem)}>
              <FieldLabel>New name</FieldLabel>
              <Input
                autoFocus
                className="h-11 font-mono"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              <FieldHelper>It stays in the same folder.</FieldHelper>
              <FieldError>{problem}</FieldError>
            </Field>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button className={ACTION} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            className={ACTION}
            disabled={Boolean(problem)}
            form="rename-form"
            isLoading={isPending}
            type="submit"
          >
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({
  kind,
  existing,
  isPending,
  onClose,
  onSubmit,
}: {
  kind: 'file' | 'folder' | null;
  existing: readonly string[];
  isPending: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState('');
  useEffect(() => setName(''), [kind]);

  const problem = kind ? nameProblem(name, existing) : null;
  const isFolder = kind === 'folder';

  return (
    <Dialog onOpenChange={({ open }) => (open ? undefined : onClose())} open={kind !== null}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="font-sans text-title-3 font-semibold">
            {isFolder ? 'New folder' : 'New file'}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="create-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!problem) onSubmit(name.trim());
            }}
          >
            <Field invalid={Boolean(problem)}>
              <FieldLabel>Name</FieldLabel>
              <Input
                autoFocus
                className="h-11 font-mono"
                onChange={(event) => setName(event.target.value)}
                placeholder={isFolder ? 'plugins' : 'server.properties'}
                value={name}
              />
              <FieldHelper>
                {isFolder
                  ? 'Created inside the folder you are looking at.'
                  : 'Created empty, in the folder you are looking at. Open it to write into it.'}
              </FieldHelper>
              <FieldError>{problem}</FieldError>
            </Field>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button className={ACTION} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            className={ACTION}
            disabled={Boolean(problem)}
            form="create-form"
            isLoading={isPending}
            type="submit"
          >
            {isFolder ? 'Create folder' : 'Create file'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  entries,
  isPending,
  onClose,
  onConfirm,
}: {
  entries: FileEntry[] | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const rows = entries ?? [];
  const single = rows.length === 1 ? rows[0] : undefined;
  const folders = rows.filter((entry) => entry.type === 'directory').length;
  const bytes = rows.reduce((total, entry) => total + entry.sizeBytes, 0);

  return (
    <AlertDialog onOpenChange={({ open }) => (open ? undefined : onClose())} open={rows.length > 0}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-sans text-title-3 font-semibold">
            {single ? `Delete ${single.name}?` : `Delete ${formatCount(rows.length, 'item')}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {single?.type === 'directory'
              ? `Everything inside ${single.name} goes with it.`
              : folders > 0
                ? `${formatCount(folders, 'folder')} and everything inside them go too.`
                : 'This removes the files from the server’s volume.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="flex flex-col gap-3 text-subhead text-label-secondary">
          <p>
            Deleted straight off the volume — there is no trash to fish it back out of. Only a
            backup taken before now can bring it back.
          </p>
          {rows.length > 1 ? (
            <ul className="max-h-40 overflow-y-auto rounded-sm bg-bg-sunken p-2 font-mono text-caption text-label-secondary">
              {rows.map((entry) => (
                <li className="truncate" key={entry.path} title={entry.path}>
                  {entry.path}
                </li>
              ))}
            </ul>
          ) : null}
          {bytes > 0 ? (
            <p className="tabular font-mono text-caption text-label-tertiary">
              {formatBytes(bytes)} freed.
            </p>
          ) : null}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel className={ACTION}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            className={ACTION}
            isLoading={isPending}
            onClick={onConfirm}
            variant="destructive"
          >
            {single ? `Delete ${single.type === 'directory' ? 'folder' : 'file'}` : 'Delete them'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
