import { isApiKeyScope, type ApiKeyScope } from '@platter/shared';

/**
 * How `ApiKey.scopes` is read, in one place.
 *
 * It lives here — a leaf with no Fastify and no Prisma — because both credential resolvers
 * need it: `plugins/auth.ts` for REST and `mcp/auth.ts` for the agent surface. A scope
 * system that only one of them consults is not a scope system; it is a suggestion, and an
 * agent handed a read-only key would simply stop speaking the surface that enforces it.
 */

/**
 * `ApiKey.scopes` is a JSON `string[]` where empty means "everything the owning user can
 * do" — see prisma/schema.prisma. Three cases, and the difference between them matters:
 *
 * - `[]` -> `null`, an unrestricted key.
 * - a list -> that set, with strings this build does not recognise dropped. A scope we
 *   cannot interpret must never widen access.
 * - unparseable -> the empty set, which denies everything. A corrupted column is not a
 *   licence; failing closed turns it into a visible outage instead of a silent grant.
 */
export function parseScopes(raw: string): ReadonlySet<ApiKeyScope> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  if (parsed.length === 0) return null;
  return new Set(parsed.filter(isApiKeyScope));
}
