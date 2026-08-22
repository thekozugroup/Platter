import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBeforeUnload, useBlocker, type BlockerFunction } from 'react-router';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';
import { LIMITS, formatBytes } from '@platter/shared';
import { Close } from 'pixelarticons/react/Close.js';
import { Save } from 'pixelarticons/react/Save.js';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { useFileContent, useWriteFile } from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { useTheme } from '@/lib/theme.js';
import { cn } from '@/lib/utils';

/**
 * The text editor for one file on a server's volume.
 *
 * Editing `server.properties` on a live box is the moment where losing work matters most, so
 * three guards sit around the same piece of state:
 *
 * - **Leaving the page.** `useBlocker` catches an in-app navigation and `useBeforeUnload`
 *   catches a tab close or reload. Closing the editor itself goes through the same dialog.
 * - **A truncated read.** The API cuts a file off at its read limit and says so. Saving what
 *   came back would silently delete everything past the cut, so a truncated file opens
 *   read-only and says why.
 * - **The write limit.** `LIMITS.maxFileEditBytes` is what the API accepts; the save button
 *   refuses past it rather than letting the request bounce.
 */

const ACTION = 'h-11 rounded-button px-4 text-subhead font-medium';

/** `navigator.platform` is deprecated and lies under emulation; the UA string is what is left. */
function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** Extra bytes a multi-byte character costs — the API measures the encoded body, not code units. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function languageFor(path: string): Extension[] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.mcmeta') || lower.endsWith('.lock')) {
    return [json()];
  }
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return [yaml()];
  // Everything else — .properties, .txt, .log, .toml — reads fine as plain text, and a wrong
  // grammar highlights more confusingly than none at all.
  return [];
}

export interface FileEditorProps {
  serverId: string;
  /** Path relative to the volume root. */
  path: string;
  /** Called once it is safe to leave — the guard has already run. */
  onClose: () => void;
  canWrite: boolean;
  className?: string;
}

export function FileEditor({ serverId, path, onClose, canWrite, className }: FileEditorProps) {
  const { resolved } = useTheme();
  const file = useFileContent(serverId, path);
  const write = useWriteFile(serverId);

  const [draft, setDraft] = useState<string | null>(null);
  /** What the server last confirmed. Comparing against this is what defines "unsaved". */
  const [saved, setSaved] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState(false);

  const loaded = file.data;

  useEffect(() => {
    if (!loaded) return;
    setDraft(loaded.content);
    setSaved(loaded.content);
  }, [loaded]);

  const dirty = draft !== null && saved !== null && draft !== saved;
  const truncated = loaded?.truncated ?? false;
  const oversize = draft !== null && byteLength(draft) > LIMITS.maxFileEditBytes;

  const readOnlyReason = !canWrite
    ? 'You can read this file but not change it. Ask the owner for the files.write permission.'
    : truncated
      ? `This file is larger than Platter reads in one go, so only the first ${formatBytes(loaded?.sizeBytes ?? 0)} is shown. Saving would delete everything past the cut, so editing is off. Download it, change it locally, and upload it back.`
      : null;
  const readOnly = readOnlyReason !== null;

  // -- guards ----------------------------------------------------------------------------

  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        dirty && currentLocation.pathname !== nextLocation.pathname,
      [dirty],
    ),
  );

  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (!dirty) return;
        // The browser shows its own wording here; the call is only what arms it.
        event.preventDefault();
      },
      [dirty],
    ),
  );

  const blocked = blocker.state === 'blocked';
  const askingToLeave = blocked || pendingClose;

  // -- saving ----------------------------------------------------------------------------

  const save = useCallback(
    (options: { thenClose?: boolean } = {}) => {
      if (draft === null || readOnly || oversize || !dirty) return;
      write.mutate(
        { path, content: draft },
        {
          onSuccess: () => {
            setSaved(draft);
            toast.create({ title: `Saved ${path.split('/').pop() ?? path}`, type: 'success' });
            if (options.thenClose) onClose();
          },
          onError: (cause: unknown) =>
            toast.create({
              title: 'Couldn’t save the file',
              description: errorMessage(cause),
              type: 'error',
            }),
        },
      );
    },
    [draft, dirty, onClose, oversize, path, readOnly, write],
  );

  /*
   * Cmd/Ctrl+S on the wrapper rather than a CodeMirror keymap extension: the synthetic event
   * bubbles out of the editable region either way, and this keeps the shortcut working when
   * focus is on the toolbar rather than in the text.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    },
    [save],
  );

  const extensions = useMemo<Extension[]>(
    () => [
      ...languageFor(path),
      EditorView.lineWrapping,
      // CodeMirror's editable surface is a bare contenteditable; without this it reaches a
      // screen reader as an unnamed text box.
      EditorView.contentAttributes.of({ 'aria-label': `Contents of ${path}` }),
    ],
    [path],
  );

  const fileName = path.split('/').pop() ?? path;

  if (file.isError) {
    return (
      <section className={cn('flex flex-col gap-4', className)}>
        <EditorChrome fileName={fileName} path={path} />
        <ErrorState
          error={file.error}
          onRetry={() => void file.refetch()}
          title="Couldn’t open that file"
          variant="inline"
        />
      </section>
    );
  }

  return (
    <section
      aria-label={`Editing ${fileName}`}
      className={cn('flex min-h-0 flex-col gap-3', className)}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <EditorChrome dirty={dirty} fileName={fileName} path={path} />

        <div className="flex flex-wrap items-center gap-2">
          {readOnly ? null : (
            <span className="hidden items-center gap-1.5 text-caption text-label-tertiary sm:flex">
              <Kbd>{isApplePlatform() ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd>S</Kbd>
              to save
            </span>
          )}
          <Button
            aria-describedby={readOnly || !dirty || oversize ? 'editor-save-hint' : undefined}
            className={ACTION}
            disabled={readOnly || !dirty || oversize}
            isLoading={write.isPending}
            onClick={() => save()}
          >
            <Save aria-hidden />
            Save
          </Button>
          <Button
            className={ACTION}
            onClick={() => (dirty ? setPendingClose(true) : onClose())}
            variant="outline"
          >
            <Close aria-hidden />
            Close
          </Button>
        </div>
      </div>

      {/* One line that always explains the state of the Save button. */}
      <p className="text-caption text-label-tertiary" id="editor-save-hint">
        {readOnlyReason ??
          (oversize
            ? `This is now ${formatBytes(byteLength(draft ?? ''))}, past the ${formatBytes(LIMITS.maxFileEditBytes)} the API accepts in one write. Trim it, or upload it as a file instead.`
            : dirty
              ? 'Unsaved changes. Most game servers only re-read their config on restart.'
              : 'Saved. Changes usually need a restart before the server picks them up.')}
      </p>

      {truncated ? (
        <Alert variant="warning">
          <AlertTitle className="font-sans">Only part of this file is shown</AlertTitle>
          <AlertDescription>{readOnlyReason}</AlertDescription>
        </Alert>
      ) : null}

      {file.isPending || draft === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-[clamp(16rem,44vh,36rem)] rounded-md" />
          <span className="sr-only" role="status">
            Reading {fileName}.
          </span>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-separator-strong">
          <CodeMirror
            editable={!readOnly}
            extensions={extensions}
            height="clamp(16rem, 44vh, 36rem)"
            onChange={setDraft}
            readOnly={readOnly}
            theme={resolved === 'dark' ? oneDark : 'light'}
            value={draft}
          />
        </div>
      )}

      <p aria-live="polite" className="sr-only" role="status">
        {write.isPending
          ? 'Saving.'
          : dirty
            ? 'This file has unsaved changes.'
            : 'This file is saved.'}
      </p>

      {/* One dialog for every way out: closing the editor, and navigating away. */}
      <AlertDialog
        onOpenChange={({ open }) => {
          if (open) return;
          setPendingClose(false);
          if (blocked) blocker.reset?.();
        }}
        open={askingToLeave}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Leave {fileName} without saving?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your edits are only in this tab. Leave now and they are gone — the file on the server
              keeps the version it already had.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="text-subhead text-label-secondary">
            {/*
              The reassurance about atomic writes is for someone who knows what a truncated
              file is; to everyone else it introduces a worry it then answers. Easy mode just
              asks the question the dialog exists for.
            */}
            {readOnly
              ? 'This file is read-only here, so there is nothing to save.'
              : 'Your changes have not been saved.'}
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel className={ACTION}>Keep editing</AlertDialogCancel>
            {!readOnly && !oversize ? (
              <Button
                className={ACTION}
                isLoading={write.isPending}
                onClick={() => {
                  setPendingClose(false);
                  save({ thenClose: !blocked });
                  if (blocked) blocker.proceed?.();
                }}
                variant="outline"
              >
                Save and leave
              </Button>
            ) : null}
            <AlertDialogAction
              className={ACTION}
              onClick={() => {
                setPendingClose(false);
                if (blocked) blocker.proceed?.();
                else onClose();
              }}
              variant="destructive"
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function EditorChrome({
  fileName,
  path,
  dirty = false,
}: {
  fileName: string;
  path: string;
  dirty?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <h3 className="min-w-0 truncate font-sans text-title-3 font-semibold text-label" title={path}>
        {fileName}
      </h3>
      {dirty ? (
        <span className="shrink-0 rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-warning">
          Unsaved
        </span>
      ) : null}
      <span className="sr-only">{path}</span>
    </div>
  );
}
