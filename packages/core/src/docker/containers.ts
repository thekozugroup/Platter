import type Docker from 'dockerode';
import type { ContainerCreateOptions } from 'dockerode';
import {
  CONTAINER_DATA_DIR,
  CONTAINER_PORTS,
  LABELS,
  MANAGED_LABEL_VALUE,
  type Result,
  TIMEOUTS,
  attempt,
  fail,
  ok,
} from '@platter/shared';
import { requireManaged } from './guard';

export interface CreateContainerInput {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Absolute host path bind-mounted at /data. */
  dataDir: string;
  network: string;
  /** Host port players connect to. */
  gamePort: number;
  /** Host port RCON is published on, bound to loopback only. Omit to keep RCON container-only. */
  rconPort?: number | undefined;
  /** Interface the game port binds to. */
  bindAddress: string;
  memoryMiB: number;
  /** Fractional CPUs, e.g. 2.5. */
  cpus: number;
  pidsLimit: number;
  restartPolicy: 'no' | 'on-failure' | 'always' | 'unless-stopped';
}

/**
 * Capabilities dropped from every game container.
 *
 * This is Wings' hardening list, which is the strongest baseline among the existing panels and
 * has held up in practice. A Minecraft server needs none of these: it binds a high port, writes
 * to one bind mount, and forks nothing. `net_bind_service` in particular is worth dropping —
 * without it a compromised process cannot squat on port 80 or 443 inside the container's
 * namespace and impersonate a service.
 */
const DROPPED_CAPABILITIES = [
  'setpcap',
  'mknod',
  'audit_write',
  'net_raw',
  'dac_override',
  'fowner',
  'fsetid',
  'net_bind_service',
  'sys_chroot',
  'setfcap',
];

/**
 * Build the Docker container specification.
 *
 * Kept as a pure function so it can be asserted against in unit tests without a daemon — the
 * hardening flags below are exactly the kind of thing that gets silently dropped in a refactor
 * and never noticed, so there is a test that pins every one of them.
 */
export function buildContainerSpec(input: CreateContainerInput): ContainerCreateOptions {
  const portBindings: Record<string, { HostIp: string; HostPort: string }[]> = {
    [`${CONTAINER_PORTS.game}/tcp`]: [
      { HostIp: input.bindAddress, HostPort: String(input.gamePort) },
    ],
    // Minecraft's server-list ping and the query protocol both use UDP on the game port.
    [`${CONTAINER_PORTS.game}/udp`]: [
      { HostIp: input.bindAddress, HostPort: String(input.gamePort) },
    ],
  };

  if (input.rconPort !== undefined) {
    // RCON is a plaintext protocol with a password that grants full server control. It is
    // pinned to loopback regardless of PLATTER_BIND_ADDRESS: Platter itself connects from the
    // host, and nobody else has any business reaching it.
    portBindings[`${CONTAINER_PORTS.rcon}/tcp`] = [
      { HostIp: '127.0.0.1', HostPort: String(input.rconPort) },
    ];
  }

  return {
    name: input.name,
    Image: input.image,
    Env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
    Labels: {
      ...input.labels,
      [LABELS.managed]: MANAGED_LABEL_VALUE,
    },
    ExposedPorts: Object.fromEntries(Object.keys(portBindings).map((port) => [port, {}])),
    // The image's own entrypoint demotes to uid 1000 after fixing ownership on /data. Setting
    // `User` here would skip that chown and leave a server unable to write its own world.
    HostConfig: {
      Binds: [`${input.dataDir}:${CONTAINER_DATA_DIR}`],
      PortBindings: portBindings,
      NetworkMode: input.network,

      // --- Resources ---
      Memory: input.memoryMiB * 1024 * 1024,
      // Swap == Memory disables swap entirely. A JVM that starts swapping does not recover; it
      // spends its time in GC and the server appears frozen rather than slow, which is a much
      // harder failure to diagnose than an honest OOM.
      MemorySwap: input.memoryMiB * 1024 * 1024,
      // Reserve 60% so the scheduler keeps the server responsive under host pressure without
      // hard-failing container creation when the host is already busy.
      MemoryReservation: Math.floor(input.memoryMiB * 0.6) * 1024 * 1024,
      NanoCpus: Math.round(input.cpus * 1e9),
      PidsLimit: input.pidsLimit,
      // Bound log growth: a mod in a crash loop can write gigabytes in minutes.
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },

      // --- Hardening ---
      Privileged: false,
      CapDrop: DROPPED_CAPABILITIES,
      SecurityOpt: ['no-new-privileges:true'],
      // The image writes install state and caches under /data (a bind mount) but also unpacks
      // into /tmp during modpack installs, so the root filesystem stays writable and /tmp is a
      // capped tmpfs rather than unbounded disk.
      ReadonlyRootfs: false,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=512m' },

      RestartPolicy: {
        Name: input.restartPolicy,
        MaximumRetryCount: input.restartPolicy === 'on-failure' ? 5 : 0,
      },
      Ulimits: [{ Name: 'nofile', Soft: 8192, Hard: 16_384 }],
    },
    // Minecraft reads console commands from stdin. Keeping it open lets Platter fall back to
    // the console channel when RCON is unavailable — during startup, or when a mod has broken
    // the RCON listener.
    OpenStdin: true,
    StdinOnce: false,
    Tty: false,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
  };
}

export async function createContainer(
  docker: Docker,
  input: CreateContainerInput
): Promise<Result<string>> {
  const spec = buildContainerSpec(input);
  const created = await attempt(() => docker.createContainer(spec));

  if (created.ok) {
    return ok((created.value as { id: string }).id);
  }

  const status = (created.error.cause as { statusCode?: number } | undefined)?.statusCode;
  if (status === 409) {
    return fail('container_conflict', `A container named ${input.name} already exists.`, {
      details: { name: input.name },
      cause: created.error,
    });
  }
  if (status === 404) {
    return fail('image_pull_failed', `Image ${input.image} is not available locally.`, {
      details: { image: input.image },
      cause: created.error,
    });
  }
  return created as Result<never>;
}

export async function startContainer(docker: Docker, containerId: string): Promise<Result<void>> {
  const guard = await requireManaged(docker, containerId);
  if (!guard.ok) {
    return guard;
  }
  if (guard.value.state === 'running') {
    return ok(undefined);
  }

  const started = await attempt(() => docker.getContainer(containerId).start());
  if (started.ok) {
    return ok(undefined);
  }

  const message = started.error.message;
  // Docker reports a port clash at start time, not create time, and the message is the only
  // machine-readable signal. Translating it lets the UI say "port 25565 is in use" instead of
  // surfacing a raw daemon error.
  if (/port is already allocated|address already in use/i.test(message)) {
    return fail('port_unavailable', 'A published port is already in use on the host.', {
      details: { containerId },
      cause: started.error,
    });
  }
  return started as Result<never>;
}

/**
 * Stop a container, giving the server time to flush chunks.
 *
 * `docker stop` sends SIGTERM, waits, then SIGKILLs. The image's `mc-server-runner` translates
 * SIGTERM into an RCON `stop`, so the wait needs to cover announce delay plus the actual world
 * save — which on a large modded world with a few hundred loaded chunks is genuinely tens of
 * seconds. The default 10s Docker timeout SIGKILLs straight through that.
 */
export async function stopContainer(
  docker: Docker,
  containerId: string,
  timeoutMs: number = TIMEOUTS.gracefulStop
): Promise<Result<void>> {
  const guard = await requireManaged(docker, containerId);
  if (!guard.ok) {
    return guard;
  }
  if (guard.value.state !== 'running') {
    return ok(undefined);
  }

  const stopped = await attempt(() =>
    docker.getContainer(containerId).stop({ t: Math.ceil(timeoutMs / 1000) })
  );

  if (stopped.ok) {
    return ok(undefined);
  }
  // 304 = already stopped. A stop that races a crash is a success, not an error.
  if ((stopped.error.cause as { statusCode?: number } | undefined)?.statusCode === 304) {
    return ok(undefined);
  }
  return stopped as Result<never>;
}

export async function restartContainer(
  docker: Docker,
  containerId: string,
  timeoutMs: number = TIMEOUTS.gracefulStop
): Promise<Result<void>> {
  const guard = await requireManaged(docker, containerId);
  if (!guard.ok) {
    return guard;
  }
  return attempt(async () => {
    await docker.getContainer(containerId).restart({ t: Math.ceil(timeoutMs / 1000) });
  });
}

/** Remove a container. Volumes are never removed here — world data outlives the container. */
export async function removeContainer(
  docker: Docker,
  containerId: string,
  options: { force?: boolean } = {}
): Promise<Result<void>> {
  const guard = await requireManaged(docker, containerId);
  if (!guard.ok) {
    // Already gone is the desired end state.
    return guard.error.code === 'container_not_found' ? ok(undefined) : guard;
  }

  const removed = await attempt(() =>
    docker.getContainer(containerId).remove({ force: options.force ?? false, v: false })
  );
  if (removed.ok) {
    return ok(undefined);
  }
  if ((removed.error.cause as { statusCode?: number } | undefined)?.statusCode === 404) {
    return ok(undefined);
  }
  return removed as Result<never>;
}

/** Send a line to the server's stdin. The fallback console channel when RCON is down. */
export async function writeToStdin(
  docker: Docker,
  containerId: string,
  line: string
): Promise<Result<void>> {
  const guard = await requireManaged(docker, containerId);
  if (!guard.ok) {
    return guard;
  }
  if (guard.value.state !== 'running') {
    return fail('invalid_state', 'Server is not running.', { details: { containerId } });
  }

  return attempt(async () => {
    const stream = await docker.getContainer(containerId).attach({
      stream: true,
      stdin: true,
      hijack: true,
    });
    await new Promise<void>((resolve, reject) => {
      stream.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    });
    stream.end();
  });
}
