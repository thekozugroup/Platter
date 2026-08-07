/**
 * Host header validation — DNS rebinding protection.
 *
 * Deliberately free of Node built-ins: this module is imported by the Next middleware, which
 * runs on the Edge runtime where `node:fs` and friends do not exist. Everything here is pure
 * string work so it can be unit tested and shared between the web app and the MCP server.
 *
 * The attack it exists to stop: a page on `evil.test` cannot read a cross-origin response from
 * `http://127.0.0.1:4880`, but it can serve `evil.test` with a one-second TTL and re-resolve it
 * to `127.0.0.1`. The browser then considers `http://evil.test:4880` same-origin — it reads the
 * response body, and because a session cookie set `sameSite: 'lax'` is same-site under that
 * name, the cookie goes along too. Loopback-only binding does not help; neither does the token.
 *
 * The check is on the *name*, because rebinding needs one. A request that arrives with an IP
 * literal in `Host` cannot have been rebound: the attacker's page would have had to name the
 * address directly, which makes it cross-origin, which means it cannot read the answer. So IP
 * literals pass without the operator having to enumerate their LAN address, and only DNS names
 * have to be vouched for.
 */

const ALWAYS_ALLOWED = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** Strip the port from a `Host` header, keeping IPv6 brackets intact. */
export function hostname(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close === -1 ? value : value.slice(0, close + 1);
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * Is this an IP literal rather than a DNS name?
 *
 * Loose on purpose. The question is not "is this a well-formed address" but "could a DNS answer
 * have produced this", and nothing resolvable is made only of digits and dots, or wrapped in
 * brackets. A malformed literal that slips through is rejected by the network stack anyway.
 */
export function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) {
    return true;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (host.includes(':') && !host.includes('.'));
}

export interface HostPolicy {
  /** Extra names to accept, from `PLATTER_ALLOWED_HOSTS`. */
  allowed: Set<string>;
}

export function hostPolicy(allowedHosts: string | undefined): HostPolicy {
  const allowed = new Set(ALWAYS_ALLOWED);
  for (const entry of (allowedHosts ?? '').split(',')) {
    const name = hostname(entry);
    if (name.length > 0) {
      allowed.add(name);
    }
  }
  return { allowed };
}

/**
 * Should a request with this `Host` header be served?
 *
 * A missing header is rejected: every HTTP/1.1 client sends one and HTTP/2 synthesises it from
 * `:authority`, so its absence means something is speaking a protocol Platter does not need to
 * accommodate.
 */
export function isHostAllowed(policy: HostPolicy, header: string | null): boolean {
  if (header === null || header.trim() === '') {
    return false;
  }
  const name = hostname(header);
  return isIpLiteral(name) || policy.allowed.has(name);
}

/**
 * Does a cross-site `Origin` accompany a state-changing request?
 *
 * Next's own Server Action guard compares `Origin` to `Host`, but API routes have no such guard,
 * and the two surfaces share a session cookie. Same comparison, applied to everything: a request
 * with no `Origin` is fine (that is a non-browser client, which the cookie never reaches
 * unprompted), and a request whose `Origin` names the same host as `Host` is fine. Anything else
 * is another site driving the user's session.
 */
export function isOriginAllowed(header: string | null, hostHeader: string | null): boolean {
  if (header === null || header === 'null') {
    return true;
  }
  let origin: URL;
  try {
    origin = new URL(header);
  } catch {
    return false;
  }
  return hostHeader !== null && origin.host.toLowerCase() === hostHeader.trim().toLowerCase();
}

/** Methods that can change state, and therefore need the `Origin` check. */
export function isStateChanging(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
