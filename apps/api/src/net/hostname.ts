import { slugify } from '@platter/shared';

/**
 * Friendly, DNS-safe hostnames for servers — "survival" instead of "192.168.1.50:25565".
 *
 * There is no column to persist a hostname in: `Server` only carries a name. So a
 * hostname is always recomputed from a server's name and id, which is why collision
 * handling has to be careful — two servers can share a name, and whatever breaks the tie
 * must not depend on anything that can change out from under an unrelated server later.
 */

/** RFC 1035 label ceiling. Real DNS and mDNS both enforce this. */
const LABEL_MAX_LENGTH = 63;

/**
 * Platter's own ceiling on the *name-derived* part of a label, well under the RFC limit.
 * Short enough that a four-character collision suffix still leaves room to spare, and
 * short enough that a human is willing to type it.
 */
const BASE_MAX_LENGTH = 40;

const SUFFIX_LENGTH = 4;

export const HOSTNAME_FALLBACK_LABEL = 'server';

const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * A single DNS label: lowercase, `[a-z0-9-]`, 1–63 characters, never starting or ending
 * with a hyphen. Every hostname this module hands out is checked against this before it
 * leaves the module, so nothing downstream — mDNS, a zone file, an HTTP response — ever
 * has to re-validate what it was given.
 */
export function isValidHostnameLabel(value: string): boolean {
  return value.length > 0 && value.length <= LABEL_MAX_LENGTH && LABEL_PATTERN.test(value);
}

/** A full dot-joined hostname: every label valid, and the whole thing under the 253-byte
 * ceiling DNS puts on a complete name. */
export function isValidHostnameChain(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value.split('.').every((label) => isValidHostnameLabel(label));
}

/**
 * The label a server's name suggests, ignoring whether anything else already has it.
 * `assignHostnames` is what actually resolves collisions; this is the shared building
 * block, reused there and by anything that only needs "roughly what this name slugifies
 * to" (log lines, previews).
 */
export function baseHostnameLabel(name: string): string {
  const slug = slugify(name, HOSTNAME_FALLBACK_LABEL)
    .slice(0, BASE_MAX_LENGTH)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : HOSTNAME_FALLBACK_LABEL;
}

/**
 * A short, stable suffix derived only from a server's own id.
 *
 * ULIDs use Crockford base32 (`0-9A-HJKMNP-TV-Z`), which lowercases into valid label
 * characters with no further escaping. Deriving the suffix from the id — not from a
 * sibling's presence or an ordinal position — is what makes it permanent: the same
 * server always gets the same suffix, whether or not the name collision that first
 * required it still exists.
 */
function idSuffix(id: string): string {
  const body = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  const tail = body.slice(-SUFFIX_LENGTH).toLowerCase().replace(/[^a-z0-9]/g, '0');
  return tail.padStart(SUFFIX_LENGTH, '0');
}

export interface HostnameCandidate {
  id: string;
  name: string;
}

/**
 * Assigns every server in the group a hostname unique within it.
 *
 * Servers that slugify to the same base label are ordered by id — which sorts
 * chronologically, see `lib/ids.ts` — and only the earliest keeps the bare label; every
 * later one gets its own id-derived suffix. That means an existing server's hostname
 * never changes because a *new* same-named server shows up later. It can still change if
 * an *earlier* same-named server is deleted and the bare label becomes free again — there
 * is no stored claim to make that impossible without a hostname column, so the service
 * layer re-registers mDNS on every start specifically so a hostname that did shift is
 * never left advertising something stale.
 *
 * Cross-group collisions — a different name's slug happening to land on `<base>-<suffix>`
 * of this group — are not checked for. It would need a stored reservation to close
 * completely, and the odds of a name coincidentally matching another server's four-
 * character id suffix are astronomically small next to that cost.
 */
export function assignHostnames(servers: readonly HostnameCandidate[]): Map<string, string> {
  const groups = new Map<string, HostnameCandidate[]>();
  for (const server of servers) {
    const base = baseHostnameLabel(server.name);
    const group = groups.get(base);
    if (group) group.push(server);
    else groups.set(base, [server]);
  }

  const assigned = new Map<string, string>();
  for (const [base, group] of groups) {
    const ordered = [...group].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    for (const [index, server] of ordered.entries()) {
      const candidate = index === 0 ? base : `${base}-${idSuffix(server.id)}`;
      const hostname = isValidHostnameLabel(candidate)
        ? candidate
        : `${HOSTNAME_FALLBACK_LABEL}-${idSuffix(server.id)}`;
      assigned.set(server.id, hostname);
    }
  }
  return assigned;
}

/**
 * The hostname for one server among a larger set — a convenience for a caller that
 * already loaded every server's id and name and wants a single lookup rather than
 * building the map itself.
 */
export function hostnameFor(serverId: string, servers: readonly HostnameCandidate[]): string {
  return assignHostnames(servers).get(serverId) ?? HOSTNAME_FALLBACK_LABEL;
}
