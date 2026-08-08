import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { FileEntry, ListFilesResponse } from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';

/**
 * The file manager for one server.
 *
 * Paths are plain strings throughout — the API's `serverPathSchema` normalises and
 * traversal-checks them server-side, so the client's only job is to send what the user
 * navigated to. Every mutation invalidates the *directory listing(s)* it could have
 * changed rather than the whole file tree, since a server's data volume can be large and a
 * full-tree refetch on every write would make the editor feel like it is fighting itself.
 */

/** No leading slash, no trailing slash, `''` is the volume root — matches `serverPathSchema`. */
function parentOf(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '' : filePath.slice(0, index);
}

function invalidateDirs(queryClient: ReturnType<typeof useQueryClient>, serverId: string, dirs: Iterable<string>) {
  for (const dir of new Set(dirs)) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.files.list(serverId, dir) });
  }
}

export function useFileList(serverId: string, path: string): UseQueryResult<ListFilesResponse> {
  return useQuery({
    queryKey: queryKeys.files.list(serverId, path),
    queryFn: () => api.get<ListFilesResponse>(`/servers/${serverId}/files`, { query: { path } }),
  });
}

export interface ReadFileResponse {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  mimeType: string | null;
}

export function useFileContent(
  serverId: string,
  path: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ReadFileResponse> {
  return useQuery({
    queryKey: queryKeys.files.content(serverId, path),
    queryFn: () => api.get<ReadFileResponse>(`/servers/${serverId}/files/content`, { query: { path } }),
    enabled: options.enabled ?? true,
  });
}

export interface WriteFileInput {
  path: string;
  content: string;
}

/** Not optimistic: a save that silently "succeeded" and then bounced would cost real work. */
export function useWriteFile(serverId: string): UseMutationResult<FileEntry, Error, WriteFileInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content }: WriteFileInput) =>
      api.put<FileEntry>(`/servers/${serverId}/files/content`, { path, content }),
    onSuccess: (_entry, { path, content }) => {
      queryClient.setQueryData<ReadFileResponse>(queryKeys.files.content(serverId, path), (previous) => ({
        path,
        content,
        sizeBytes: previous?.sizeBytes ?? content.length,
        truncated: false,
        mimeType: previous?.mimeType ?? null,
      }));
    },
    onSettled: (_entry, _error, { path }) => invalidateDirs(queryClient, serverId, [parentOf(path)]),
  });
}

export function useCreateDirectory(serverId: string): UseMutationResult<FileEntry, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.post<FileEntry>(`/servers/${serverId}/files/directories`, { path }),
    onSuccess: (_entry, path) => invalidateDirs(queryClient, serverId, [parentOf(path)]),
  });
}

export interface RenamePathInput {
  from: string;
  to: string;
}

interface RenameContext {
  previous: ListFilesResponse | undefined;
  dir: string;
}

/** Optimistic when the rename stays inside one folder — the common case, and the one
 *  where the rollback is exactly "put the old name back". A cross-folder move just
 *  invalidates both ends; guessing at a partial move is more confusing than a brief wait. */
export function useRenamePath(
  serverId: string,
): UseMutationResult<FileEntry, Error, RenamePathInput, RenameContext> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ from, to }: RenamePathInput) =>
      api.post<FileEntry>(`/servers/${serverId}/files/rename`, { from, to }),
    onMutate: async ({ from, to }) => {
      const fromDir = parentOf(from);
      const toDir = parentOf(to);
      if (fromDir !== toDir) return { previous: undefined, dir: fromDir };

      await queryClient.cancelQueries({ queryKey: queryKeys.files.list(serverId, fromDir) });
      const previous = queryClient.getQueryData<ListFilesResponse>(queryKeys.files.list(serverId, fromDir));
      if (previous) {
        const toName = to.slice(to.lastIndexOf('/') + 1);
        queryClient.setQueryData<ListFilesResponse>(queryKeys.files.list(serverId, fromDir), {
          ...previous,
          entries: previous.entries.map((entry) =>
            entry.path === from ? { ...entry, name: toName, path: to } : entry,
          ),
        });
      }
      return { previous, dir: fromDir };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.files.list(serverId, context.dir), context.previous);
      }
    },
    onSettled: (_entry, _error, { from, to }) =>
      invalidateDirs(queryClient, serverId, [parentOf(from), parentOf(to)]),
  });
}

export interface CopyPathInput {
  from: string;
  to: string;
}

export function useCopyPath(serverId: string): UseMutationResult<FileEntry, Error, CopyPathInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ from, to }: CopyPathInput) => api.post<FileEntry>(`/servers/${serverId}/files/copy`, { from, to }),
    onSuccess: (_entry, { to }) => invalidateDirs(queryClient, serverId, [parentOf(to)]),
  });
}

export interface DeletePathsResult {
  deleted: string[];
}

/** Not optimistic: deletion is destructive, and "undo by re-adding to the list" is not
 *  actually a rollback of anything that happened on disk. */
export function useDeletePaths(serverId: string): UseMutationResult<DeletePathsResult, Error, string[]> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => api.post<DeletePathsResult>(`/servers/${serverId}/files/delete`, { paths }),
    onSuccess: (result) => invalidateDirs(queryClient, serverId, result.deleted.map(parentOf)),
  });
}

export interface CompressPathsInput {
  paths: string[];
  destination?: string;
}

export function useCompressPaths(serverId: string): UseMutationResult<FileEntry, Error, CompressPathsInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ paths, destination }: CompressPathsInput) =>
      api.post<FileEntry>(`/servers/${serverId}/files/compress`, { paths, destination }),
    onSuccess: (entry) => invalidateDirs(queryClient, serverId, [parentOf(entry.path)]),
  });
}

export interface ExtractArchiveInput {
  path: string;
  destination?: string;
}

export function useExtractArchive(serverId: string): UseMutationResult<FileEntry, Error, ExtractArchiveInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, destination }: ExtractArchiveInput) =>
      api.post<FileEntry>(`/servers/${serverId}/files/extract`, { path, destination: destination ?? '' }),
    onSuccess: (_entry, { destination, path }) =>
      invalidateDirs(queryClient, serverId, [destination ?? parentOf(path)]),
  });
}

export interface UploadFileInput {
  /** Destination folder; `''` is the volume root. */
  path: string;
  file: File;
}

export function useUploadFile(serverId: string): UseMutationResult<FileEntry, Error, UploadFileInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, file }: UploadFileInput) => {
      const body = new FormData();
      body.append('file', file);
      return api.post<FileEntry>(`/servers/${serverId}/files/upload`, body, { query: { path } });
    },
    onSuccess: (_entry, { path }) => invalidateDirs(queryClient, serverId, [path]),
  });
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/**
 * Fetches an authenticated binary resource, bypassing `api.request` on purpose: it decodes
 * every non-JSON response as UTF-8 text, which corrupts a gzip archive or a binary file.
 * The API only accepts a Bearer token or an API key (see `plugins/auth.ts`), never a plain
 * cookie, so a bare `<a href>` to the API cannot authenticate — this attaches the token by
 * hand the same way `api-client.ts`'s own `stream()` does for SSE.
 */
export async function fetchAuthenticatedBlob(
  path: string,
  query: Record<string, string | number | boolean | undefined | null> | undefined,
  fallbackName: string,
): Promise<{ blob: Blob; filename: string }> {
  const headers = new Headers();
  if (api.accessToken) headers.set('authorization', `Bearer ${api.accessToken}`);
  const response = await fetch(api.url(path, query), { headers, credentials: 'include' });
  if (!response.ok) throw new Error("Couldn't download that. Try again.");

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition');
  const match = disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition) : null;
  const filename = match?.[1] ? decodeURIComponent(match[1]) : fallbackName;
  return { blob, filename };
}

/** Saves a blob the way a normal `<a download>` would, without ever adding one to the DOM. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function useDownloadFile(serverId: string): UseMutationResult<void, Error, string> {
  return useMutation({
    mutationFn: async (path: string) => {
      const fallback = path.slice(path.lastIndexOf('/') + 1) || 'file';
      const { blob, filename } = await fetchAuthenticatedBlob(
        `/servers/${serverId}/files/download`,
        { path },
        fallback,
      );
      saveBlob(blob, filename);
    },
  });
}
