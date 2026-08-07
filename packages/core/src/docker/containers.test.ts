import { describe, expect, it } from 'vitest';
import { buildContainerSpec, type CreateContainerInput } from './containers';

/**
 * The hardening flags are exactly the kind of thing that disappears in a refactor and is never
 * noticed, because nothing fails — the container just quietly runs with more privilege than it
 * needs. Every one of them is pinned here.
 */

const base: CreateContainerInput = {
  name: 'platter-test-abcd1234',
  image: 'itzg/minecraft-server:java21',
  env: { EULA: 'TRUE', TYPE: 'PAPER' },
  labels: { 'platter.server.id': '01H', 'platter.game': 'minecraft' },
  dataDir: '/srv/platter/servers/01H/data',
  network: 'platter',
  gamePort: 25_565,
  rconPort: 25_575,
  bindAddress: '0.0.0.0',
  memoryMiB: 4096,
  cpus: 2,
  pidsLimit: 512,
  restartPolicy: 'unless-stopped',
};

describe('buildContainerSpec', () => {
  it('marks the container as Platter-managed', () => {
    const spec = buildContainerSpec(base);
    // The label is what every destructive operation checks before acting. Without it, the guard
    // refuses to touch the container and the server becomes unmanageable.
    expect(spec.Labels?.['platter.managed']).toBe('true');
    expect(spec.Labels?.['platter.server.id']).toBe('01H');
  });

  it('drops the capabilities a Minecraft server has no use for', () => {
    const dropped = buildContainerSpec(base).HostConfig?.CapDrop ?? [];
    for (const capability of [
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
    ]) {
      expect(dropped).toContain(capability);
    }
  });

  it('refuses privilege escalation and privileged mode', () => {
    const spec = buildContainerSpec(base);
    expect(spec.HostConfig?.Privileged).toBe(false);
    expect(spec.HostConfig?.SecurityOpt).toContain('no-new-privileges:true');
  });

  it('caps memory, CPU and pids', () => {
    const host = buildContainerSpec(base).HostConfig;
    expect(host?.Memory).toBe(4096 * 1024 * 1024);
    expect(host?.NanoCpus).toBe(2e9);
    expect(host?.PidsLimit).toBe(512);
  });

  it('disables swap by setting MemorySwap equal to Memory', () => {
    // A JVM that starts swapping does not recover — it spends its life in GC and the server
    // looks frozen rather than slow, which is a much harder failure to diagnose than an OOM.
    const host = buildContainerSpec(base).HostConfig;
    expect(host?.MemorySwap).toBe(host?.Memory);
  });

  it('caps log files so a crash loop cannot fill the disk', () => {
    const log = buildContainerSpec(base).HostConfig?.LogConfig;
    expect(log?.Type).toBe('json-file');
    expect(log?.Config?.['max-size']).toBeDefined();
    expect(log?.Config?.['max-file']).toBeDefined();
  });

  it('gives /tmp a capped, noexec tmpfs', () => {
    const tmpfs = buildContainerSpec(base).HostConfig?.Tmpfs ?? {};
    expect(tmpfs['/tmp']).toContain('noexec');
    expect(tmpfs['/tmp']).toContain('nosuid');
    expect(tmpfs['/tmp']).toMatch(/size=\d+m/);
  });

  it('joins Platter’s own network rather than the default bridge', () => {
    // On the default bridge every container can reach every other one, including other servers’
    // RCON ports.
    expect(buildContainerSpec(base).HostConfig?.NetworkMode).toBe('platter');
  });

  it('publishes the game port on TCP and UDP', () => {
    // Server-list ping and the query protocol are UDP; without it servers look offline in the
    // multiplayer list even though they accept connections.
    const bindings = buildContainerSpec(base).HostConfig?.PortBindings ?? {};
    expect(bindings['25565/tcp']?.[0]?.HostPort).toBe('25565');
    expect(bindings['25565/udp']?.[0]?.HostPort).toBe('25565');
  });

  it('pins RCON to loopback regardless of the configured bind address', () => {
    const bindings = buildContainerSpec({ ...base, bindAddress: '0.0.0.0' }).HostConfig
      ?.PortBindings as Record<string, { HostIp: string; HostPort: string }[]>;

    expect(bindings['25565/tcp']?.[0]?.HostIp).toBe('0.0.0.0');
    // RCON is a plaintext protocol whose password grants full server control. It must never
    // follow PLATTER_BIND_ADDRESS onto a public interface.
    expect(bindings['25575/tcp']?.[0]?.HostIp).toBe('127.0.0.1');
  });

  it('omits the RCON binding entirely when no host port is allocated', () => {
    const bindings = buildContainerSpec({ ...base, rconPort: undefined }).HostConfig?.PortBindings;
    expect(bindings?.['25575/tcp']).toBeUndefined();
  });

  it('bind-mounts the data directory at /data', () => {
    expect(buildContainerSpec(base).HostConfig?.Binds).toEqual([
      '/srv/platter/servers/01H/data:/data',
    ]);
  });

  it('leaves the user unset so the image can chown /data before demoting', () => {
    // Setting User here skips the entrypoint's chown and leaves a server unable to write its
    // own world.
    expect(buildContainerSpec(base).User).toBeUndefined();
  });

  it('keeps stdin open for the console fallback', () => {
    const spec = buildContainerSpec(base);
    expect(spec.OpenStdin).toBe(true);
    expect(spec.StdinOnce).toBe(false);
  });

  it('bounds retries for on-failure restarts', () => {
    const always = buildContainerSpec({ ...base, restartPolicy: 'always' });
    expect(always.HostConfig?.RestartPolicy?.MaximumRetryCount).toBe(0);

    const onFailure = buildContainerSpec({ ...base, restartPolicy: 'on-failure' });
    expect(onFailure.HostConfig?.RestartPolicy?.Name).toBe('on-failure');
    expect(onFailure.HostConfig?.RestartPolicy?.MaximumRetryCount).toBeGreaterThan(0);
  });

  it('reserves less memory than it limits', () => {
    const host = buildContainerSpec(base).HostConfig;
    expect(host?.MemoryReservation).toBeLessThan(host?.Memory ?? 0);
    expect(host?.MemoryReservation).toBeGreaterThan(0);
  });
});
