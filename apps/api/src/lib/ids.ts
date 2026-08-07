import { monotonicFactory } from 'ulid';

/**
 * Entity -> identifier prefix. A prefixed id says what it points at, which turns a value
 * pasted into a bug report or a log line into something self-describing.
 */
export const ID_PREFIXES = {
  server: 'srv',
  user: 'usr',
  node: 'nod',
  backup: 'bak',
  schedule: 'sch',
  audit: 'aud',
  apiKey: 'key',
  subuser: 'sub',
  allocation: 'alc',
  conversation: 'cnv',
  message: 'msg',
  session: 'ses',
} as const;

export type IdEntity = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdEntity];

const PREFIXES: readonly string[] = Object.values(ID_PREFIXES);

/**
 * Monotonic rather than plain ULID: two ids minted in the same millisecond still sort in
 * creation order. That is what lets list endpoints order by id and skip a createdAt index.
 */
const nextUlid = monotonicFactory();

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nextUlid()}`;
}

/**
 * Cheap shape check for untrusted input, before it reaches a `where` clause. Passing a
 * prefix also asserts the id refers to the entity the route expects, so a backup id in a
 * server route is rejected at the boundary instead of returning an empty result.
 */
export function isId(value: unknown, prefix?: IdPrefix): boolean {
  if (typeof value !== 'string') return false;
  const separator = value.indexOf('_');
  if (separator < 1) return false;

  const found = value.slice(0, separator);
  const body = value.slice(separator + 1);
  if (body.length === 0 || !/^[0-9A-Za-z]+$/.test(body)) return false;

  return prefix === undefined ? PREFIXES.includes(found) : found === prefix;
}

/** The prefix of a well-formed id, or null. Useful for rendering polymorphic audit targets. */
export function idPrefix(value: string): string | null {
  const separator = value.indexOf('_');
  if (separator < 1) return null;
  const found = value.slice(0, separator);
  return PREFIXES.includes(found) ? found : null;
}
