import { Suspense, lazy, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import type { FileEntry } from '@platter/shared';
import { FileBrowser } from '@/components/files/file-browser';
import { PageBody } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { SECTION_HEADING, useServerScope } from './ServerLayout';

/**
 * The files tab.
 *
 * The current folder and the open file both live in the URL, not in component state. That is
 * what makes "send me a link to the crash report" work, and it means the browser's own Back
 * button walks back up a folder tree the way people expect it to.
 *
 * The editor is loaded on demand. CodeMirror and its two grammars are around 300 kB, and most
 * visits to this tab are to download a world or drop in a plugin jar — paying for an editor
 * nobody opened would make the common case the slow one.
 */
const FileEditor = lazy(async () => ({
  default: (await import('@/components/files/file-editor')).FileEditor,
}));

export function FilesPage() {
  const { server, blueprint } = useServerScope();
  const [params, setParams] = useSearchParams();

  const path = params.get('path') ?? '';
  const editing = params.get('file');

  const navigate = useCallback(
    (next: string) => {
      setParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          updated.delete('file');
          if (next === '') updated.delete('path');
          else updated.set('path', next);
          return updated;
        },
        // Folder hops are ordinary navigation and belong in history; opening a file replaces,
        // so Back from the editor returns to the folder rather than to the previous folder.
        { replace: false },
      );
    },
    [setParams],
  );

  const openFile = useCallback(
    (entry: FileEntry) => {
      setParams((previous) => {
        const updated = new URLSearchParams(previous);
        updated.set('file', entry.path);
        return updated;
      });
    },
    [setParams],
  );

  const closeEditor = useCallback(() => {
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      updated.delete('file');
      return updated;
    });
  }, [setParams]);

  /*
   * Permissions are not readable from the client — the API decides — so this is deliberately
   * optimistic and the real refusal comes back as a 403 with a message. The one thing that is
   * knowable up front is a suspended or deleting server, where every write will fail.
   */
  const frozen = server.status === 'deleting' || server.status === 'suspended';
  const canWrite = !frozen;
  const canDelete = !frozen;

  return (
    <PageBody className="flex flex-col gap-8">
      {editing !== null ? (
        <Suspense
          fallback={
            <div className="flex flex-col gap-3">
              <Skeleton className="h-11 w-64 rounded-sm" />
              <Skeleton className="h-[clamp(16rem,44vh,36rem)] rounded-md" />
              <span className="sr-only" role="status">
                Opening the editor.
              </span>
            </div>
          }
        >
          <FileEditor
            canWrite={canWrite}
            key={editing}
            onClose={closeEditor}
            path={editing}
            serverId={server.id}
          />
        </Suspense>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h2 className={SECTION_HEADING}>Files</h2>
            <p className="max-w-prose text-subhead text-label-secondary">
              Everything on {server.name}’s data volume, mounted at{' '}
              <code className="font-mono text-footnote">{blueprint?.dataPath ?? '/data'}</code>{' '}
              inside the container. Most game servers only re-read their config on restart.
            </p>
          </div>

          <FileBrowser
            canDelete={canDelete}
            canWrite={canWrite}
            onNavigate={navigate}
            onOpenFile={openFile}
            path={path}
            serverId={server.id}
            serverName={server.name}
          />

          {frozen ? (
            <p className="text-caption text-label-tertiary" role="status">
              {server.status === 'deleting'
                ? 'This server is being deleted, so the volume is read-only until it is gone.'
                : 'This server is suspended. Its files are readable but nothing can be changed until an administrator lifts the suspension.'}
            </p>
          ) : null}
        </>
      )}
    </PageBody>
  );
}
