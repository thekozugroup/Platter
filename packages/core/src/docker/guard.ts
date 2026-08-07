import type Docker from 'dockerode';
import { LABELS, MANAGED_LABEL_VALUE, type Result, fail, ok } from '@platter/shared';

/**
 * The blast-radius limiter.
 *
 * Platter drives the Docker socket, which is root-equivalent on the host. The realistic risk is
 * not a clever attacker — it is an ordinary bug: a null id, an off-by-one in a filter, a stale
 * container reference that now points at something the user cares about. Any of those, wired
 * straight to `container.remove()`, deletes somebody's database.
 *
 * So every destructive Docker call in Platter goes through this module, and this module refuses
 * to act on anything not carrying `platter.managed=true`. The check costs one `inspect` per
 * operation; that is a rounding error next to `docker stop`, and it converts a whole class of
 * bug from "destroyed unrelated containers" into "returned an error".
 */

export interface ManagedContainer {
  id: string;
  name: string;
  serverId: string | undefined;
  labels: Record<string, string>;
  state: string;
  status: string;
  /** Docker's own health check verdict, when the image defines one. */
  health: 'starting' | 'healthy' | 'unhealthy' | 'none';
  exitCode: number | undefined;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  /** hostPort keyed by `containerPort/protocol`, e.g. `25565/tcp`. */
  ports: Record<string, number>;
  image: string;
}

interface InspectResult {
  Id: string;
  Name: string;
  Config: { Labels?: Record<string, string> | null; Image: string };
  State: {
    Status: string;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string };
  };
  NetworkSettings: {
    Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
  };
}

function toManaged(info: InspectResult): ManagedContainer {
  const labels = info.Config.Labels ?? {};
  const ports: Record<string, number> = {};
  for (const [key, bindings] of Object.entries(info.NetworkSettings.Ports ?? {})) {
    const first = bindings?.[0];
    if (first) {
      ports[key] = Number(first.HostPort);
    }
  }

  const rawHealth = info.State.Health?.Status;
  const health: ManagedContainer['health'] =
    rawHealth === 'healthy' || rawHealth === 'unhealthy' || rawHealth === 'starting'
      ? rawHealth
      : 'none';

  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ''),
    serverId: labels[LABELS.serverId],
    labels,
    state: info.State.Status,
    status: info.State.Status,
    health,
    exitCode: info.State.ExitCode,
    startedAt: info.State.StartedAt,
    finishedAt: info.State.FinishedAt,
    ports,
    image: info.Config.Image,
  };
}

/**
 * Inspect a container and assert Platter owns it.
 *
 * Callers must use this — never `docker.getContainer(id)` directly — before any mutation.
 */
export async function requireManaged(
  docker: Docker,
  containerId: string,
  options: { expectServerId?: string } = {}
): Promise<Result<ManagedContainer>> {
  let info: InspectResult;
  try {
    info = (await docker.getContainer(containerId).inspect()) as unknown as InspectResult;
  } catch (cause) {
    const status = (cause as { statusCode?: number }).statusCode;
    if (status === 404) {
      return fail('container_not_found', `No container with id ${containerId}.`, {
        details: { containerId },
        cause,
      });
    }
    return fail('docker_unavailable', `Could not inspect container ${containerId}.`, {
      details: { containerId },
      cause,
    });
  }

  const managed = toManaged(info);

  if (managed.labels[LABELS.managed] !== MANAGED_LABEL_VALUE) {
    return fail(
      'invalid_state',
      `Container ${managed.name} is not managed by Platter and will not be modified.`,
      { details: { containerId, name: managed.name } }
    );
  }

  if (options.expectServerId && managed.serverId !== options.expectServerId) {
    return fail(
      'invalid_state',
      `Container ${managed.name} belongs to server ${managed.serverId ?? 'unknown'}, ` +
        `not ${options.expectServerId}.`,
      { details: { containerId, expected: options.expectServerId, actual: managed.serverId } }
    );
  }

  return ok(managed);
}

/** Inspect without asserting ownership. Read-only callers (status polling) use this. */
export async function inspectContainer(
  docker: Docker,
  containerId: string
): Promise<Result<ManagedContainer>> {
  try {
    const info = (await docker.getContainer(containerId).inspect()) as unknown as InspectResult;
    return ok(toManaged(info));
  } catch (cause) {
    const status = (cause as { statusCode?: number }).statusCode;
    if (status === 404) {
      return fail('container_not_found', `No container with id ${containerId}.`, {
        details: { containerId },
        cause,
      });
    }
    return fail('docker_unavailable', `Could not inspect container ${containerId}.`, { cause });
  }
}

/** Every container Platter owns, whether running or not. */
export async function listManaged(docker: Docker): Promise<Result<ManagedContainer[]>> {
  try {
    const summaries = await docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.managed}=${MANAGED_LABEL_VALUE}`] },
    });
    const detailed = await Promise.all(
      summaries.map(async (summary) => {
        const info = (await docker
          .getContainer(summary.Id)
          .inspect()) as unknown as InspectResult;
        return toManaged(info);
      })
    );
    return ok(detailed);
  } catch (cause) {
    return fail('docker_unavailable', 'Could not list Platter containers.', { cause });
  }
}

/** Find the container belonging to a server, if one exists. */
export async function findByServerId(
  docker: Docker,
  serverId: string
): Promise<Result<ManagedContainer | undefined>> {
  try {
    const summaries = await docker.listContainers({
      all: true,
      filters: {
        label: [`${LABELS.managed}=${MANAGED_LABEL_VALUE}`, `${LABELS.serverId}=${serverId}`],
      },
    });
    const first = summaries[0];
    if (!first) {
      return ok(undefined);
    }
    const info = (await docker.getContainer(first.Id).inspect()) as unknown as InspectResult;
    return ok(toManaged(info));
  } catch (cause) {
    return fail('docker_unavailable', `Could not look up container for server ${serverId}.`, {
      cause,
    });
  }
}
