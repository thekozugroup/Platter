import { isIP } from 'node:net';
import type { Allocation, Node as NodeRow, Server as ServerRow } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { LIMITS, PlatterError, type Blueprint, type ServerAllocation } from '@platter/shared';
import { prisma } from '../db.js';
import { badRequest, invalidState, isPrismaKnownError, notFound } from '../lib/errors.js';
import { parseDockerEndpoint } from '../orchestration/docker.js';
import { assignHostnames, hostnameFor, isValidHostnameChain } from '../net/hostname.js';
import { isAdvertised, isMdnsAvailable, registerServer, unregisterServer } from '../net/mdns.js';
import { probeAddress, isPortFree, type ProbeResult } from '../net/probe.js';
import {
  DEFAULT_ZONE,
  buildZoneFile,
  connectString,
  fqdn,
  isMdnsEligible,
  isValidZoneName,
  type SrvRecordInput,
  type ZoneARecord,
  type ZoneSrvRecord,
} from '../net/zone.js';
import { getBlueprint } from './blueprints.js';

/**
 * Friendly addressing: turns a server row into something a player can type.
 *
 * `mdns.ts` and `zone.ts` are pure — no database, no I/O — so this file is the only place
 * that has to reconcile "what does the database say" with "what is actually being
 * advertised right now" (mDNS is per-process, in-memory state; see its own header).
 *
 * The Minecraft Java client's SRV convention is the only one standardised enough to
 * publish automatically. Every other blueprint still gets a working hostname — the A
 * record is unconditional — it just needs its port typed alongside it.
 */

const ZONE_SETTING_KEY = 'network.zone';
const PUBLIC_IP_SETTING_KEY = 'network.publicIp';

/** The only blueprint whose client performs the `_minecraft._tcp.<host>` SRV lookup. */
function wantsMinecraftSrv(blueprintKey: string): boolean {
  return blueprintKey === 'minecraft-java';
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface NetworkContext {
  server: ServerRow;
  node: NodeRow;
  allocations: Allocation[];
}

async function loadContext(serverId: string): Promise<NetworkContext> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { node: true, allocations: true },
  });
  if (!server) throw notFound('server');
  return { server, node: server.node, allocations: server.allocations };
}

/** A server whose blueprint file was removed still has an address worth showing. */
async function findBlueprint(key: string): Promise<Blueprint | null> {
  try {
    return getBlueprint(key);
  } catch (error) {
    if (error instanceof PlatterError && error.code === 'not_found') return null;
    throw error;
  }
}

function primaryAllocation(allocations: readonly Allocation[]): Allocation | undefined {
  return allocations.find((allocation) => allocation.primary) ?? allocations[0];
}

/** Allocations always bind `0.0.0.0`; the node's declared public address stands in for
 * "the address anything outside this host actually dials". Mirrors `services/players.ts`. */
function hostFor(node: NodeRow, hostIp: string): string {
  return hostIp === '0.0.0.0' || hostIp === '::' || hostIp.length === 0 ? node.publicHost : hostIp;
}

/** Only a node reachable over a local socket shares a network stack with this process —
 * see `services/allocations.ts` for the same rule applied to picking new ports. */
function isLocalNode(node: NodeRow): boolean {
  try {
    return parseDockerEndpoint(node.endpoint).socketPath !== undefined;
  } catch {
    return false;
  }
}

function toWireAllocation(row: Allocation, blueprint: Blueprint | null): ServerAllocation {
  const containerPort = blueprint?.ports.find((port) => port.name === row.portName)?.containerPort;
  return {
    name: row.portName ?? 'game',
    hostIp: row.hostIp,
    hostPort: row.hostPort,
    containerPort: containerPort ?? row.hostPort,
    protocol: row.protocol === 'udp' ? 'udp' : 'tcp',
    primary: row.primary,
  };
}

function toWireAllocations(rows: readonly Allocation[], blueprint: Blueprint | null): ServerAllocation[] {
  return rows
    .map((row) => toWireAllocation(row, blueprint))
    .sort((left, right) => Number(right.primary) - Number(left.primary) || left.hostPort - right.hostPort);
}

async function resolveHostname(serverId: string): Promise<string> {
  const siblings = await prisma.server.findMany({ select: { id: true, name: true } });
  return hostnameFor(serverId, siblings);
}

// ---------------------------------------------------------------------------
// Zone settings
// ---------------------------------------------------------------------------

export interface NetworkZoneSettings {
  zone: string;
  /** The router's WAN IP for the wildcard A record. Null when nobody has told Platter —
   * it has no way to detect this itself from behind NAT. */
  publicIp: string | null;
}

async function readSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function getZoneSettings(): Promise<NetworkZoneSettings> {
  const [storedZone, publicIp] = await Promise.all([
    readSetting(ZONE_SETTING_KEY),
    readSetting(PUBLIC_IP_SETTING_KEY),
  ]);
  // A zone value that no longer validates (hand-edited database, a future stricter rule)
  // degrades to the default rather than propagating an invalid domain any further.
  const zone = storedZone && isValidZoneName(storedZone) ? storedZone : DEFAULT_ZONE;
  return { zone, publicIp };
}

export interface UpdateZoneInput {
  zone?: string;
  /** `null` clears the override and goes back to "unknown, show a placeholder". */
  publicIp?: string | null;
}

export async function updateZoneSettings(input: UpdateZoneInput): Promise<NetworkZoneSettings> {
  if (input.zone !== undefined) {
    const zone = input.zone.trim().toLowerCase();
    if (!isValidZoneName(zone)) {
      throw badRequest('That is not a valid domain.', {
        zone: ['Use a domain like games.example.com, or the default platter.local.'],
      });
    }
    await prisma.setting.upsert({
      where: { key: ZONE_SETTING_KEY },
      create: { key: ZONE_SETTING_KEY, value: zone },
      update: { value: zone },
    });
  }

  if (input.publicIp !== undefined) {
    if (input.publicIp === null) {
      await prisma.setting.deleteMany({ where: { key: PUBLIC_IP_SETTING_KEY } });
    } else {
      const ip = input.publicIp.trim();
      if (isIP(ip) === 0) {
        throw badRequest('That is not a valid IP address.', {
          publicIp: ['Use a plain IPv4 or IPv6 address — your router usually shows this on its status page.'],
        });
      }
      await prisma.setting.upsert({
        where: { key: PUBLIC_IP_SETTING_KEY },
        create: { key: PUBLIC_IP_SETTING_KEY, value: ip },
        update: { value: ip },
      });
    }
  }

  return getZoneSettings();
}

export interface ZoneRecordsResult extends NetworkZoneSettings {
  wildcardA: ZoneARecord;
  srvRecords: ZoneSrvRecord[];
  zoneFileText: string;
}

/** Every record an operator needs to point a real domain at this Platter install. */
export async function getZoneRecords(): Promise<ZoneRecordsResult> {
  const { zone, publicIp } = await getZoneSettings();

  const candidates = await prisma.server.findMany({
    select: {
      id: true,
      name: true,
      blueprintKey: true,
      allocations: { where: { primary: true }, select: { hostPort: true } },
    },
  });
  const hostnames = assignHostnames(candidates);

  const srvInputs: SrvRecordInput[] = [];
  for (const candidate of candidates) {
    if (!wantsMinecraftSrv(candidate.blueprintKey)) continue;
    const label = hostnames.get(candidate.id);
    const port = candidate.allocations[0]?.hostPort;
    if (label !== undefined && port !== undefined) srvInputs.push({ label, port });
  }

  const zoneFile = buildZoneFile({ zone, target: publicIp, servers: srvInputs });
  return {
    zone,
    publicIp,
    wildcardA: zoneFile.wildcardA,
    srvRecords: zoneFile.srvRecords,
    zoneFileText: zoneFile.text,
  };
}

// ---------------------------------------------------------------------------
// Per-server address
// ---------------------------------------------------------------------------

export interface ServerSrvInfo {
  service: string;
  protocol: 'tcp' | 'udp';
  target: string;
  port: number;
}

export interface ServerNetworkAddress {
  serverId: string;
  /** Bare label, e.g. `survival` — no zone suffix. */
  hostname: string;
  zone: string;
  /** `survival.platter.local` — no trailing dot, no port. */
  fqdn: string;
  ip: string;
  port: number;
  protocol: 'tcp' | 'udp';
  /** Whether this process is actually advertising the hostname over mDNS right now. */
  mdnsAvailable: boolean;
  srv: ServerSrvInfo | null;
  connectString: string;
  allocations: ServerAllocation[];
}

export async function getServerAddress(serverId: string): Promise<ServerNetworkAddress> {
  const { server, node, allocations } = await loadContext(serverId);
  const primary = primaryAllocation(allocations);
  if (!primary) throw invalidState('This server has no allocated ports yet.');

  const [{ zone }, hostname, blueprint] = await Promise.all([
    getZoneSettings(),
    resolveHostname(serverId),
    findBlueprint(server.blueprintKey),
  ]);

  const address = fqdn(hostname, zone);
  if (!isValidHostnameChain(address)) {
    // Should be unreachable — every piece that built `address` is already validated — but
    // an address a client cannot use must never reach the wire pretending otherwise.
    throw invalidState('This server does not have a usable address yet.');
  }

  const mdnsEligible = isMdnsEligible(zone);
  const mdnsAvailable = mdnsEligible && isMdnsAvailable() && isAdvertised(serverId);
  // A custom (non-`.local`) zone is the operator's own DNS, which Platter cannot verify
  // from here — once they have configured one, the hostname is presented as live, the
  // same trust the rendered zone file already asks of them.
  const hostnameResolves = mdnsEligible ? mdnsAvailable : true;
  const minecraftSrv = wantsMinecraftSrv(server.blueprintKey) && hostnameResolves;

  const protocol: 'tcp' | 'udp' = primary.protocol === 'udp' ? 'udp' : 'tcp';
  const srv: ServerSrvInfo | null = minecraftSrv
    ? { service: '_minecraft', protocol: 'tcp', target: address, port: primary.hostPort }
    : null;

  return {
    serverId,
    hostname,
    zone,
    fqdn: address,
    ip: node.publicHost,
    port: primary.hostPort,
    protocol,
    mdnsAvailable,
    srv,
    connectString: connectString({
      hostname: address,
      ip: node.publicHost,
      port: primary.hostPort,
      hostnameResolves,
      srvCoversPort: srv !== null,
    }),
    allocations: toWireAllocations(allocations, blueprint),
  };
}

/**
 * Publishes a server's `.local` name, called by the lifecycle when it reaches `running`.
 *
 * Never throws and never rejects. Discovery is a convenience layered on top of a
 * host:port address that already works, so a responder that cannot bind — or a server row
 * that vanished mid-boot — must not be able to fail a start. Everything it needs (the
 * hostname, the zone, the primary port) is resolved here rather than in the lifecycle so
 * `net/mdns.ts` stays a pure record registry with no database of its own.
 */
export async function advertiseServer(serverId: string, logger?: FastifyBaseLogger): Promise<void> {
  try {
    const { zone } = await getZoneSettings();
    if (!isMdnsEligible(zone)) return;

    const { server, allocations } = await loadContext(serverId);
    const primary = primaryAllocation(allocations);
    if (!primary) return;

    const hostname = fqdn(await resolveHostname(serverId), zone);
    if (!isValidHostnameChain(hostname)) return;

    registerServer(
      {
        serverId,
        hostname,
        port: primary.hostPort,
        minecraftSrv: wantsMinecraftSrv(server.blueprintKey),
      },
      logger,
    );
  } catch (error) {
    logger?.warn({ err: error, serverId }, 'could not advertise a server over mDNS');
  }
}

/** Drops the advertisement when a server stops or is deleted. Safe to call for a server
 * that was never advertised. */
export function withdrawServer(serverId: string, logger?: FastifyBaseLogger): void {
  unregisterServer(serverId, logger);
}

export async function listServerAllocations(serverId: string): Promise<ServerAllocation[]> {
  const { server, allocations } = await loadContext(serverId);
  const blueprint = await findBlueprint(server.blueprintKey);
  return toWireAllocations(allocations, blueprint);
}

// ---------------------------------------------------------------------------
// Manual port change
// ---------------------------------------------------------------------------

export interface ChangePortResult {
  allocation: ServerAllocation;
  /** The container already exists with the old mapping baked in — Docker port bindings
   * are fixed at creation, so this only takes effect the next time the server starts. */
  requiresRestart: boolean;
}

function portConflict(hostPort: number, node: NodeRow): PlatterError {
  return new PlatterError('no_allocation_available', `Port ${hostPort} is already in use on ${node.name}.`, {
    details: { hostPort: [`Port ${hostPort} is already in use on ${node.name}.`] },
  });
}

export async function changeServerPort(
  serverId: string,
  portName: string,
  hostPort: number,
): Promise<ChangePortResult> {
  if (hostPort < LIMITS.minPort || hostPort > LIMITS.maxPort) {
    throw badRequest(`Choose a port between ${LIMITS.minPort} and ${LIMITS.maxPort}.`, {
      hostPort: [`Must be between ${LIMITS.minPort} and ${LIMITS.maxPort}.`],
    });
  }

  const { server, node, allocations } = await loadContext(serverId);
  const target = allocations.find((allocation) => allocation.portName === portName);
  if (!target) throw notFound('port');

  const blueprint = await findBlueprint(server.blueprintKey);
  if (target.hostPort === hostPort) {
    return { allocation: toWireAllocation(target, blueprint), requiresRestart: false };
  }

  const existing = await prisma.allocation.findFirst({
    where: { nodeId: node.id, hostPort, protocol: target.protocol, id: { not: target.id } },
    select: { id: true },
  });
  if (existing) throw portConflict(hostPort, node);

  if (isLocalNode(node)) {
    const free = await isPortFree(hostPort, target.protocol === 'udp' ? 'udp' : 'tcp');
    if (!free) throw portConflict(hostPort, node);
  }

  let updated: Allocation;
  try {
    updated = await prisma.allocation.update({ where: { id: target.id }, data: { hostPort } });
  } catch (error) {
    // The unique constraint on (nodeId, hostIp, hostPort, protocol) is the final word: a
    // concurrent change that won the race here is not a bug, just the expected outcome.
    if (isPrismaKnownError(error) && error.code === 'P2002') throw portConflict(hostPort, node);
    throw error;
  }

  return { allocation: toWireAllocation(updated, blueprint), requiresRestart: server.containerId !== null };
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

export async function checkServerReachability(serverId: string, portName?: string): Promise<ProbeResult> {
  const { node, allocations } = await loadContext(serverId);
  const target = portName
    ? allocations.find((allocation) => allocation.portName === portName)
    : primaryAllocation(allocations);
  if (!target) throw notFound('port');

  return probeAddress({
    host: hostFor(node, target.hostIp),
    port: target.hostPort,
    protocol: target.protocol === 'udp' ? 'udp' : 'tcp',
    isLocalNode: isLocalNode(node),
  });
}
