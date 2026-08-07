import 'server-only';
import { networkInterfaces } from 'node:os';

/**
 * The address to hand to other people.
 *
 * The overview page's whole purpose is producing an address someone can paste into Discord, and
 * it used to show `localhost:25565` directly beneath the words "Give this address to anyone on
 * your network". Everyone who tried it connected to their own machine. Platter publishes game
 * ports on every interface by default (`PLATTER_BIND_ADDRESS`), so the LAN address genuinely
 * works — it just was never displayed.
 *
 * Picking one is a heuristic, and it is stated as such in the UI rather than presented as fact:
 * a machine can have several private addresses (docker0, a VPN, two NICs) and only the person
 * at the keyboard knows which network their friends are on. So this returns candidates in
 * best-first order and the page shows the first with the rest available, rather than pretending
 * there is one right answer.
 */

/** Interfaces that are never the address a friend should use. */
const IGNORED_PREFIXES = ['docker', 'br-', 'veth', 'virbr', 'lo', 'utun', 'tun', 'tap', 'zt'];

function rank(address: string): number {
  // Ordinary home and office LANs first, since that is where the friends are.
  if (address.startsWith('192.168.')) return 0;
  if (/^10\./.test(address)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

export interface LanAddress {
  address: string;
  /** The OS's name for the interface, so a multi-homed machine is disambiguable. */
  iface: string;
}

export function lanAddresses(): LanAddress[] {
  const found: LanAddress[] = [];

  for (const [iface, entries] of Object.entries(networkInterfaces())) {
    if (IGNORED_PREFIXES.some((prefix) => iface.toLowerCase().startsWith(prefix))) {
      continue;
    }
    for (const entry of entries ?? []) {
      // IPv4 only: an IPv6 literal needs brackets, and the Minecraft client's server-address
      // field handles them inconsistently across versions. Not worth the support burden.
      if (entry.family !== 'IPv4' || entry.internal) {
        continue;
      }
      found.push({ address: entry.address, iface });
    }
  }

  return found.sort((a, b) => rank(a.address) - rank(b.address));
}
