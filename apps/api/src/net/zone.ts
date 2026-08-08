import { formatAddress } from '@platter/shared';
import { isValidHostnameLabel } from './hostname.js';

/**
 * Real-DNS support for operators who want a server reachable outside their own LAN.
 *
 * mDNS (`mdns.ts`) only ever works on the local network segment — that is the whole point
 * of it, and also its ceiling. Getting `survival.example.com` to resolve from anywhere
 * else means the operator's own DNS provider, which needs records handed to it. This
 * module only renders those records; it never talks to a resolver or a registrar.
 */

export const DEFAULT_ZONE = 'platter.local';

/** RFC 1035's ceiling on a complete domain name. */
const MAX_ZONE_LENGTH = 253;

/**
 * A zone is a domain — at least two labels, each individually DNS-safe. `platter.local`
 * and `games.example.com` both qualify; a bare label like `home` does not, because
 * `<slug>.home` would not be a legal DNS name to hand a resolver.
 */
export function isValidZoneName(zone: string): boolean {
  if (zone.length === 0 || zone.length > MAX_ZONE_LENGTH) return false;
  const labels = zone.split('.');
  return labels.length >= 2 && labels.every((label) => isValidHostnameLabel(label));
}

/**
 * True when a zone ends in the pseudo-TLD every resolver treats as multicast rather than
 * routing to a real DNS server (RFC 6762 §3). This is what decides whether `mdns.ts`
 * should even try to advertise a server's hostname: a record for anything else would sit
 * in its registry and simply never be queried.
 */
export function isMdnsEligible(zone: string): boolean {
  const lower = zone.toLowerCase();
  return lower === 'local' || lower.endsWith('.local');
}

/** `survival.example.com` — the address a person would actually type, no trailing dot. */
export function fqdn(label: string, zone: string): string {
  return `${label}.${zone}`;
}

export interface ZoneARecord {
  /** `*.example.com.` — a zone-file name, trailing dot included. */
  name: string;
  target: string;
  ttl: number;
  line: string;
}

/** A single, human-friendly placeholder — never a guess — for when Platter has no idea
 * what public IP the operator's router actually has. Showing a wrong address is worse
 * than showing an obvious blank to fill in. */
const UNKNOWN_TARGET = '<YOUR-PUBLIC-IP>';

/**
 * One wildcard A record covering every server under the zone, so adding a server never
 * means going back to the DNS provider to add another record.
 */
export function buildWildcardARecord(zone: string, target: string | null, ttl = 300): ZoneARecord {
  const name = `*.${zone}.`;
  const value = target ?? UNKNOWN_TARGET;
  return { name, target: value, ttl, line: `${name}\t${ttl}\tIN\tA\t${value}` };
}

export interface SrvRecordInput {
  /** The server's own hostname label, e.g. `survival` — no zone suffix. */
  label: string;
  port: number;
  /** Bare service name, no leading underscore. Default `minecraft`. */
  service?: string;
  protocol?: 'tcp' | 'udp';
  priority?: number;
  weight?: number;
}

export interface ZoneSrvRecord {
  /** `_minecraft._tcp.survival.example.com.` — what a client actually queries. */
  name: string;
  service: string;
  protocol: 'tcp' | 'udp';
  priority: number;
  weight: number;
  port: number;
  /** `survival.example.com.` — resolved by the wildcard A record above. */
  target: string;
  ttl: number;
  line: string;
}

const DEFAULT_SRV_SERVICE = 'minecraft';
const DEFAULT_SRV_PRIORITY = 0;
const DEFAULT_SRV_WEIGHT = 5;

/**
 * One SRV record for one server.
 *
 * This is the record that lets a Minecraft Java client resolve a bare hostname with no
 * port: the client queries `_<service>._<protocol>.<address>` before it ever tries to
 * connect to `<address>` directly, so as long as this exists under the zone the wildcard A
 * record already covers, typing the address alone is enough.
 */
export function buildSrvRecord(zone: string, input: SrvRecordInput, ttl = 120): ZoneSrvRecord {
  const service = input.service ?? DEFAULT_SRV_SERVICE;
  const protocol = input.protocol ?? 'tcp';
  const priority = input.priority ?? DEFAULT_SRV_PRIORITY;
  const weight = input.weight ?? DEFAULT_SRV_WEIGHT;
  const target = `${fqdn(input.label, zone)}.`;
  const name = `_${service}._${protocol}.${target}`;

  return {
    name,
    service: `_${service}`,
    protocol,
    priority,
    weight,
    port: input.port,
    target,
    ttl,
    line: `${name}\t${ttl}\tIN\tSRV\t${priority} ${weight} ${input.port} ${target}`,
  };
}

export interface ZoneFile {
  zone: string;
  wildcardA: ZoneARecord;
  srvRecords: ZoneSrvRecord[];
  /** The whole thing, ready to paste into a zone file or a DNS provider's raw-record box. */
  text: string;
}

export interface BuildZoneFileInput {
  zone: string;
  /** The operator's public IP, if known. Null renders an honest placeholder instead. */
  target: string | null;
  /** Only the servers that should get an SRV entry — deciding which is the caller's job
   * (only the Minecraft Java blueprint's convention is standardised enough to publish). */
  servers: readonly SrvRecordInput[];
}

export function buildZoneFile(input: BuildZoneFileInput): ZoneFile {
  const wildcardA = buildWildcardARecord(input.zone, input.target);
  const srvRecords = input.servers.map((server) => buildSrvRecord(input.zone, server));

  const lines = [
    `; Platter DNS zone for ${input.zone}`,
    `; Generated ${new Date().toISOString()} — add these records at your DNS provider.`,
    '',
    wildcardA.line,
    ...srvRecords.map((record) => record.line),
  ];

  return { zone: input.zone, wildcardA, srvRecords, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Connect string
// ---------------------------------------------------------------------------

export interface ConnectStringInput {
  /** `survival.example.com` — no trailing dot, no port. */
  hostname: string;
  /** Numeric fallback for when the hostname cannot actually be resolved right now. */
  ip: string;
  port: number;
  /** Whether anything makes `hostname` resolve at all — mDNS publish succeeded, or a
   * non-default zone is configured and assumed to be wired up at the operator's DNS. */
  hostnameResolves: boolean;
  /** Whether an SRV record actually covers `port` for this hostname. */
  srvCoversPort: boolean;
}

/**
 * The shortest thing a player can actually type.
 *
 * Three tiers, each only as short as the network actually supports: a raw `ip:port` when
 * the hostname would not resolve at all, `hostname:port` when it resolves but nothing
 * tells the client which port to use, and the bare hostname only when an SRV record
 * genuinely covers the port — the one case where a player can type an address with
 * nothing else.
 */
export function connectString(input: ConnectStringInput): string {
  if (!input.hostnameResolves) return formatAddress(input.ip, input.port);
  if (input.srvCoversPort) return input.hostname;
  return formatAddress(input.hostname, input.port);
}
