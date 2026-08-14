import { formatAddress } from '@platter/shared';

/**
 * The one place that decides what string a person is shown as "the address".
 *
 * Platter's headline promise is that a friend can be handed a name and join, so the address
 * is the single most consequential string on the screen — and it is also the easiest one to
 * get wrong, because the record the UI happens to have in hand is a *bind* address. A
 * container is published on `0.0.0.0` so the kernel accepts traffic on every interface;
 * `0.0.0.0` is not somewhere a client can dial. Printing it next to a copy button hands the
 * user a value that is guaranteed to fail, with nothing to explain why.
 *
 * Preference order, best first:
 *   1. `connectString` — the shortest thing that actually works, computed by the API from
 *      the server's hostname, zone and SRV record (`GET /servers/:id/network`).
 *   2. `primaryAddress` — the node's public host and the published port.
 *   3. A `host:port` built from an allocation, but only when the host is routable.
 *
 * A wildcard or unspecified host never survives any of those paths.
 */

/**
 * Hosts that mean "listen everywhere" rather than "connect here": IPv4 `0.0.0.0`, IPv6 `::`
 * (and its bracketed and mapped spellings), and the empty string.
 */
function isUnroutableHost(host: string): boolean {
  const bare = host
    .trim()
    .replace(/^\[|]$/g, '')
    .toLowerCase();
  return (
    bare.length === 0 ||
    bare === '0.0.0.0' ||
    bare === '::' ||
    bare === '::0' ||
    bare === '0:0:0:0:0:0:0:0' ||
    bare === '::ffff:0.0.0.0'
  );
}

/** `host:port`, or null when the host is a bind address no client could use. */
export function routableAddress(host: string, port: number): string | null {
  return isUnroutableHost(host) ? null : formatAddress(host, port);
}

/**
 * Accepts anything summary-shaped. `connectString` is optional so this keeps working
 * whether or not the list payload carries one — when the API starts sending it on the
 * summary, every card picks it up with no further change here.
 */
export interface AddressBearing {
  primaryAddress?: string | null;
  connectString?: string | null;
}

/** The address to display, or null when the server has no usable one yet. */
export function connectAddress(
  source: AddressBearing,
  fallback?: { host: string; port: number } | null,
): string | null {
  const preferred = source.connectString ?? source.primaryAddress ?? null;
  if (preferred && !isUnroutableHost(preferred.replace(/:\d+$/, ''))) return preferred;
  if (fallback) return routableAddress(fallback.host, fallback.port);
  return null;
}
