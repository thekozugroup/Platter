import { QueryClient, type QueryClientConfig } from '@tanstack/react-query';
import { ApiError, NetworkError } from './api-client.js';

/**
 * Query keys in one place.
 *
 * Every key is a function returning a tuple, so invalidation can be as broad or as narrow
 * as the mutation warrants — `queryKeys.servers.all` invalidates every server query,
 * `queryKeys.servers.detail(id)` only the one that changed. Ad-hoc string keys scattered
 * across components are how stale-after-mutation bugs happen.
 */
export const queryKeys = {
  bootstrap: () => ['bootstrap'] as const,
  session: () => ['session'] as const,

  servers: {
    all: ['servers'] as const,
    /*
     * Every list query, and nothing else. `all` is a prefix of the per-server caches too
     * (`files.all`, `backups.all`, every metric series), so invalidating it to refresh a
     * name or a status refetches the open Files tab and every chart on screen.
     */
    lists: ['servers', 'list'] as const,
    list: (params: Record<string, unknown>) => ['servers', 'list', params] as const,
    detail: (id: string) => ['servers', 'detail', id] as const,
    stats: (id: string) => ['servers', 'detail', id, 'stats'] as const,
    subusers: (id: string) => ['servers', 'detail', id, 'subusers'] as const,
  },
  files: {
    all: (serverId: string) => ['servers', serverId, 'files'] as const,
    list: (serverId: string, path: string) => ['servers', serverId, 'files', 'list', path] as const,
    content: (serverId: string, path: string) =>
      ['servers', serverId, 'files', 'content', path] as const,
  },
  backups: {
    all: (serverId: string) => ['servers', serverId, 'backups'] as const,
  },
  schedules: {
    all: (serverId: string) => ['servers', serverId, 'schedules'] as const,
  },
  blueprints: {
    all: ['blueprints'] as const,
    detail: (key: string) => ['blueprints', key] as const,
  },
  nodes: {
    all: ['nodes'] as const,
    detail: (id: string) => ['nodes', id] as const,
    capacity: (id: string) => ['nodes', id, 'capacity'] as const,
  },
  users: {
    all: ['users'] as const,
    detail: (id: string) => ['users', id] as const,
  },
  audit: {
    list: (params: Record<string, unknown>) => ['audit', params] as const,
  },
  system: {
    info: () => ['system', 'info'] as const,
    settings: () => ['system', 'settings'] as const,
    health: () => ['system', 'health'] as const,
  },
  ai: {
    status: () => ['ai', 'status'] as const,
    conversations: (serverId: string) => ['ai', serverId, 'conversations'] as const,
  },
} as const;

/**
 * Retry policy. The default (three retries on everything) is actively harmful here: a 403
 * will never become a 200, and retrying it three times just delays the error the user needs
 * to see. Only retry things that could plausibly change.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof NetworkError) return true;
  if (error instanceof ApiError) return error.retryable;
  return false;
}

export const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      /*
       * 15s of freshness covers the burst of refetches from navigating between a server's
       * tabs without hitting the API for every tab change, while staying short enough that
       * a status change surfaces quickly. Live data (console, stats) comes over the socket
       * rather than by polling, so this does not have to be aggressive.
       */
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: false,
    },
  },
};

export function createQueryClient(): QueryClient {
  return new QueryClient(queryClientConfig);
}
