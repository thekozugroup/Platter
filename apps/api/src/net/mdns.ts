import Bonjour from 'bonjour-service';
import type { FastifyBaseLogger } from 'fastify';
import { networkInterfaces } from 'node:os';

/**
 * Zero-config discovery over mDNS: every running server gets `<slug>.platter.local`
 * for free, on macOS and iOS without a single setting changed anywhere.
 *
 * The Minecraft Java client performs an SRV lookup at `_minecraft._tcp.<address>` before
 * it ever tries `<address>` directly, so a correct SRV record is what lets a player type
 * a bare hostname with no port — that is the actual usability win here, not the A record
 * alone.
 *
 * `bonjour-service`'s public `publish()` API only knows how to shape a DNS-SD service
 * instance (`<name>._type._proto.local`), which is a different record than the one above:
 * DNS-SD puts the instance name *before* the service type, Minecraft's convention puts
 * the service type directly in front of the address with no instance name at all. There
 * is no way to make `Service`/`Registry` produce that shape — `Service.records()` always
 * builds the DNS-SD layout. The underlying responder those classes call into
 * (`Bonjour['server']`, a thin wrapper around `multicast-dns` with a flat name/type
 * registry) answers whatever is in that registry regardless of how it got there, through
 * a public `register`/`unregister` pair; TypeScript's declaration file marks the field
 * private, but nothing in the compiled library enforces that at runtime, and it is the
 * only route to a record shape a real Minecraft client will use. The cast below is scoped
 * to exactly the two calls this file makes against it.
 */

interface RawRecord {
  name: string;
  type: 'A' | 'AAAA' | 'SRV';
  ttl: number;
  data: string | { port: number; target: string };
}

interface RawRecordRegistry {
  register(records: RawRecord[]): void;
  unregister(records: RawRecord[]): void;
  mdns: NodeJS.EventEmitter;
}

function rawRegistry(bonjour: Bonjour): RawRecordRegistry {
  return (bonjour as unknown as { server: RawRecordRegistry }).server;
}

const A_TTL = 120;
const SRV_TTL = 120;
const SRV_SERVICE = '_minecraft._tcp';

export interface ServerAdvertisement {
  serverId: string;
  /** Fully-qualified, no trailing dot — e.g. `survival.platter.local`. Callers validate
   * this with `hostname.ts` before it ever reaches here. */
  hostname: string;
  port: number;
  /** Only the Minecraft Java client's SRV convention applies to this blueprint; other
   * games still get the host record, just not this. */
  minecraftSrv: boolean;
}

interface AdvertisedEntry {
  hostname: string;
  records: RawRecord[];
}

let instance: Bonjour | null = null;
/** Set once the responder is known broken; never retried in this process — a second
 * attempt would hit the same permission or network problem the first one did. */
let unavailableReason: string | null = null;
const advertised = new Map<string, AdvertisedEntry>();

function localAddresses(): Array<{ address: string; family: 'IPv4' | 'IPv6' }> {
  const addresses: Array<{ address: string; family: 'IPv4' | 'IPv6' }> = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      // Loopback resolves nothing useful to another device on the LAN, and an all-zero
      // MAC is a virtual adapter (seen on some CI runners) that is not reachable either.
      if (info.internal || info.mac === '00:00:00:00:00:00') continue;
      addresses.push({ address: info.address, family: info.family === 'IPv6' ? 'IPv6' : 'IPv4' });
    }
  }
  return addresses;
}

function hostRecords(hostname: string): RawRecord[] {
  return localAddresses().map(({ address, family }) => ({
    name: hostname,
    type: family === 'IPv6' ? ('AAAA' as const) : ('A' as const),
    ttl: A_TTL,
    data: address,
  }));
}

function srvRecord(hostname: string, port: number): RawRecord {
  return {
    name: `${SRV_SERVICE}.${hostname}`,
    type: 'SRV',
    ttl: SRV_TTL,
    data: { port, target: hostname },
  };
}

function recordsFor(advertisement: ServerAdvertisement): RawRecord[] {
  const records = hostRecords(advertisement.hostname);
  if (advertisement.minecraftSrv)
    records.push(srvRecord(advertisement.hostname, advertisement.port));
  return records;
}

function markUnavailable(reason: string, logger?: FastifyBaseLogger): void {
  if (unavailableReason) return;
  unavailableReason = reason;
  logger?.warn(
    { reason },
    'mDNS is unavailable on this host; servers fall back to host:port addresses',
  );
}

function ensureInstance(logger?: FastifyBaseLogger): Bonjour | null {
  if (unavailableReason) return null;
  if (instance) return instance;

  try {
    const bonjour = new Bonjour(undefined, (error: Error) => {
      logger?.warn({ err: error }, 'mDNS responder failed to answer a query');
    });
    // `multicast-dns` emits its own `error` for anything from a failed multicast join to a
    // permission-denied bind, and nothing upstream of it listens for that event — left
    // alone, that is an *unhandled* `error` event, which Node treats as fatal. A LAN
    // convenience feature must never be able to take the whole process down with it.
    rawRegistry(bonjour).mdns.on('error', (error: Error) => {
      markUnavailable(error.message, logger);
    });
    instance = bonjour;
    return instance;
  } catch (error) {
    markUnavailable(error instanceof Error ? error.message : String(error), logger);
    return null;
  }
}

export function isMdnsAvailable(): boolean {
  return unavailableReason === null;
}

function removeEntry(serverId: string, logger?: FastifyBaseLogger): void {
  const entry = advertised.get(serverId);
  advertised.delete(serverId);
  if (!entry || !instance) return;
  try {
    rawRegistry(instance).unregister(entry.records);
  } catch (error) {
    // The record's own TTL (120s) is the backstop if this somehow fails: it simply
    // expires from any cache that already picked it up.
    logger?.warn({ err: error, serverId }, 'failed to unpublish an mDNS record cleanly');
  }
}

/**
 * Publishes (or updates) a server's mDNS advertisement.
 *
 * Never throws: nothing about zero-config discovery may be allowed to stop a server from
 * starting. Call this again with a new hostname to handle a rename — it replaces whatever
 * was previously registered for the same `serverId` — and call `unregisterServer` when the
 * server stops so a dead entry does not keep answering queries for a container that is no
 * longer running.
 */
export function registerServer(
  advertisement: ServerAdvertisement,
  logger?: FastifyBaseLogger,
): void {
  if (!advertisement.hostname.toLowerCase().endsWith('.local')) {
    // Every resolver only routes `.local` names to multicast (RFC 6762 §3). A record
    // under any other domain would sit in the registry and simply never be queried —
    // that domain is what `zone.ts` exists for instead.
    logger?.debug(
      { hostname: advertisement.hostname },
      'hostname is not under .local; skipping mDNS',
    );
    return;
  }

  const bonjour = ensureInstance(logger);
  if (!bonjour) return;

  try {
    removeEntry(advertisement.serverId, logger);
    const records = recordsFor(advertisement);
    rawRegistry(bonjour).register(records);
    advertised.set(advertisement.serverId, { hostname: advertisement.hostname, records });
  } catch (error) {
    logger?.warn({ err: error, serverId: advertisement.serverId }, 'failed to publish mDNS record');
  }
}

export function unregisterServer(serverId: string, logger?: FastifyBaseLogger): void {
  removeEntry(serverId, logger);
}

/** Whether a server currently has a live mDNS advertisement — what `services/network.ts`
 * checks before promising a player the bare-hostname `connectString`. */
export function isAdvertised(serverId: string): boolean {
  return advertised.has(serverId);
}

/** Graceful shutdown: unpublishes everything and closes the responder's socket. */
export function stopMdns(): void {
  const bonjour = instance;
  instance = null;
  advertised.clear();
  if (!bonjour) return;
  try {
    bonjour.destroy();
  } catch {
    // The process is exiting either way.
  }
}

/** Test-only: drops every cached advertisement and the disabled flag so the next call
 * starts clean, mirroring `orchestration/registry.ts`'s `resetDrivers`. */
export function resetMdnsForTests(): void {
  stopMdns();
  unavailableReason = null;
}
