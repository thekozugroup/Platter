import { existsSync } from 'node:fs';
import { attempt, fail, ok, type PlatterError, type Result } from '@platter/shared';
import Docker from 'dockerode';

export interface DockerClientOptions {
  /** Unix socket path or a tcp:// URL. */
  socket: string;
  /** Overrides `socket` when set, matching Docker CLI behaviour. */
  dockerHost?: string | undefined;
}

/**
 * Build a dockerode client from Platter's configuration.
 *
 * `DOCKER_HOST` wins over the configured socket, so a user who has already pointed their shell
 * at a remote engine, Colima, Rancher Desktop or a rootless socket does not have to configure
 * Platter separately. Getting this wrong is the most common "it works in my terminal but not in
 * the app" report against tools like this.
 */
export function createDockerClient(options: DockerClientOptions): Docker {
  const host = options.dockerHost ?? process.env.DOCKER_HOST;

  if (host) {
    const url = new URL(host.replace(/^tcp:\/\//, 'http://'));
    if (url.protocol === 'unix:') {
      return new Docker({ socketPath: url.pathname });
    }
    return new Docker({
      host: url.hostname,
      port: url.port ? Number(url.port) : 2375,
      protocol: url.protocol === 'https:' ? 'https' : 'http',
    });
  }

  return new Docker({ socketPath: options.socket });
}

export interface DockerHealth {
  version: string;
  apiVersion: string;
  os: string;
  arch: string;
  /** Total memory the engine reports, bytes. Used to sanity-check server memory limits. */
  memTotal: number;
  cpus: number;
  /** Docker's own storage driver — worth surfacing, since overlay2 vs vfs changes disk use. */
  storageDriver: string;
}

/**
 * Verify the daemon is reachable and usable, translating the two failure modes people actually
 * hit into actionable errors rather than a raw ENOENT/EACCES.
 */
export async function checkDocker(
  docker: Docker,
  socketPath: string
): Promise<Result<DockerHealth>> {
  const probe = await attempt(async () => {
    const [version, info] = await Promise.all([docker.version(), docker.info()]);
    return { version, info } as {
      version: { Version: string; ApiVersion: string; Os: string; Arch: string };
      info: { MemTotal: number; NCPU: number; Driver: string };
    };
  }, 'docker_unavailable');

  if (probe.ok) {
    const { version, info } = probe.value;
    return ok({
      version: version.Version,
      apiVersion: version.ApiVersion,
      os: version.Os,
      arch: version.Arch,
      memTotal: info.MemTotal,
      cpus: info.NCPU,
      storageDriver: info.Driver,
    });
  }

  const cause = probe.error;
  const code = (cause.cause as NodeJS.ErrnoException | undefined)?.code;

  if (code === 'EACCES') {
    return fail(
      'docker_permission_denied',
      `Permission denied opening the Docker socket at ${socketPath}. ` +
        'Add your user to the "docker" group (`sudo usermod -aG docker $USER`, then log out and ' +
        'back in), or point PLATTER_DOCKER_SOCKET at a rootless socket.',
      { details: { socketPath }, cause }
    );
  }

  if (code === 'ENOENT' || !existsSync(socketPath)) {
    return fail(
      'docker_unavailable',
      `No Docker daemon at ${socketPath}. Start Docker (or Colima/Rancher/OrbStack) and try ` +
        'again, or set DOCKER_HOST / PLATTER_DOCKER_SOCKET if the engine lives elsewhere.',
      { details: { socketPath }, cause }
    );
  }

  return fail('docker_unavailable', `Could not reach the Docker daemon: ${cause.message}`, {
    details: { socketPath },
    cause,
  });
}

/**
 * Ensure Platter's bridge network exists.
 *
 * Game containers join a dedicated network rather than the default bridge. On the default
 * bridge every container can reach every other one, so a compromised mod on one server could
 * talk to another server's RCON port. A named bridge is one line of setup for meaningful
 * containment — and it is what PufferPanel's host-networking model gives up entirely.
 */
export async function ensureNetwork(docker: Docker, name: string): Promise<Result<string>> {
  const existing = await attempt(() => docker.listNetworks({ filters: { name: [name] } }));
  if (!existing.ok) {
    return existing;
  }

  const match = (existing.value as { Name: string; Id: string }[]).find((n) => n.Name === name);
  if (match) {
    return ok(match.Id);
  }

  const created = await attempt(() =>
    docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      CheckDuplicate: true,
      Labels: { 'platter.managed': 'true' },
    })
  );

  if (created.ok) {
    return ok((created.value as { id: string }).id);
  }

  // A concurrent Platter process may have created it between our list and create calls.
  if (created.error.message.includes('already exists')) {
    const retry = await attempt(() => docker.listNetworks({ filters: { name: [name] } }));
    if (retry.ok) {
      const found = (retry.value as { Name: string; Id: string }[]).find((n) => n.Name === name);
      if (found) {
        return ok(found.Id);
      }
    }
  }

  return created as Result<never>;
}

export type { PlatterError };
export { Docker };
