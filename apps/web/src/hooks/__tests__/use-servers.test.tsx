import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from '@platter/shared';
import { queryKeys } from '@/lib/query.js';
import { useCreateServer, useServers } from '../use-servers.js';
import { useRenameServer } from '../use-server.js';

/**
 * The data layer's load-bearing behaviour: a plain list fetch, a mutation that populates
 * the cache from its response, and — the one worth the most coverage — an optimistic
 * mutation that rolls back cleanly when the API disagrees. `use-server.ts`'s power-action
 * and delete mutations are deliberately *not* optimistic (see the guide), so there is
 * nothing analogous to test there beyond "it posts the right body", which the route
 * contract in `apps/api/src/routes/servers.ts` already pins down.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function makeServer(overrides: Partial<Server> = {}): Server {
  return {
    id: 'srv_1',
    name: 'Survival SMP',
    description: '',
    blueprintKey: 'minecraft-java',
    nodeId: 'nod_1',
    ownerId: 'usr_1',
    status: 'running',
    containerId: 'container-1',
    limits: { memoryMb: 4096, diskMb: 10_240, cpuCores: 2, swapMb: 0, ioWeight: 500 },
    allocations: [],
    connectString: null,
    variables: {},
    redactedVariables: [],
    autoStart: true,
    autoRestart: true,
    lastExitCode: null,
    lastCrashAt: null,
    installedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useServers', () => {
  it('fetches a page of summaries', async () => {
    mockFetch((url) => {
      expect(url).toContain('/api/v1/servers');
      expect(url).toContain('search=smp');
      return json({
        data: [
          {
            id: 'srv_1',
            name: 'Survival SMP',
            blueprintKey: 'minecraft-java',
            status: 'running',
            nodeId: 'nod_1',
            primaryAddress: 'play.example.com:25565',
            memoryMb: 4096,
            cpuCores: 2,
            playersOnline: 3,
            playersMax: 20,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: { page: 1, perPage: 25, total: 1, totalPages: 1 },
      });
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useServers({ search: 'smp' }), { wrapper: wrapperFor(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toHaveLength(1);
    expect(result.current.data?.data[0]?.name).toBe('Survival SMP');
  });
});

describe('useCreateServer', () => {
  it('seeds the detail cache from the response and invalidates the list', async () => {
    const created = makeServer({ id: 'srv_new', name: 'Fresh Server' });
    mockFetch((url, init) => {
      expect(init?.method).toBe('POST');
      expect(url).toContain('/api/v1/servers');
      return json(created, 201);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateServer(), { wrapper: wrapperFor(queryClient) });

    result.current.mutate({
      name: 'Fresh Server',
      description: '',
      blueprintKey: 'minecraft-java',
      variables: {},
      ports: {},
      autoStart: true,
      autoRestart: true,
      startOnCreate: true,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(queryKeys.servers.detail('srv_new'))).toEqual(created);
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.servers.all }),
    );
  });
});

describe('useRenameServer', () => {
  it('applies the new name immediately and rolls back if the API rejects it', async () => {
    const original = makeServer({ name: 'Old Name' });
    let resolveFetch: ((response: Response) => void) | undefined;

    mockFetch((url, init) => {
      expect(init?.method).toBe('PATCH');
      expect(url).toContain('/api/v1/servers/srv_1');
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.servers.detail('srv_1'), original);

    const { result } = renderHook(() => useRenameServer('srv_1'), { wrapper: wrapperFor(queryClient) });

    result.current.mutate('New Name');

    // Optimistic: the cache reflects the new name before the API has answered at all.
    await waitFor(() =>
      expect(queryClient.getQueryData<Server>(queryKeys.servers.detail('srv_1'))?.name).toBe('New Name'),
    );

    // The API disagrees — the field is invalid, or the name collided.
    resolveFetch?.(
      json({ error: { code: 'validation_failed', message: 'Some fields need attention.' } }, 422),
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData<Server>(queryKeys.servers.detail('srv_1'))?.name).toBe('Old Name');
  });
});
