import { checkDocker, listServers } from '@platter/core';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Health endpoint.
 *
 * Returns 200 whenever Platter itself is serving requests, even when Docker is unreachable —
 * because "Platter is up but Docker is down" is a state the operator needs to *see*, and a
 * container that keeps restarting because its dependency is down shows them nothing. The Docker
 * state is reported in the body instead.
 */
export async function GET(): Promise<Response> {
  const result = await tryGetContext();

  if (!result.ok) {
    return Response.json(
      {
        status: 'degraded',
        docker: { reachable: false, error: result.error.message, code: result.error.code },
        servers: null,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const docker = await checkDocker(result.context.docker, result.context.env.PLATTER_DOCKER_SOCKET);
  const servers = listServers(result.context.db);

  return Response.json(
    {
      status: docker.ok ? 'ok' : 'degraded',
      docker: docker.ok
        ? { reachable: true, version: docker.value.version, cpus: docker.value.cpus }
        : { reachable: false, error: docker.error.message },
      servers: {
        total: servers.length,
        running: servers.filter((server) => server.status === 'running').length,
        unhealthy: servers.filter(
          (server) => server.status === 'unhealthy' || server.status === 'crashed'
        ).length,
      },
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
