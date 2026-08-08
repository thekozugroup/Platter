import type { Server as ServerRecord } from '@prisma/client';
import { SERVER_PERMISSIONS, type ServerPermission } from '@platter/shared';
import { prisma } from '../db.js';
import { forbidden, notFound, tokenExpired, unauthenticated } from '../lib/errors.js';
import { constantTimeEqual, sha256Hex } from '../lib/password.js';
import { AUTH_USER_SELECT, toAuthenticatedUser, type AuthenticatedUser } from '../plugins/auth.js';
import { serverPermissionsFor } from '../services/servers.js';

/**
 * Who is calling the MCP server, and what they are allowed to do.
 *
 * An agent is a principal, not an exception (docs/ARCHITECTURE.md §4). Every tool call is
 * authorised twice: once against the API key's scopes, and once against the very same
 * per-server permission a human faces on the equivalent HTTP route. Neither check has an
 * agent-shaped hole in it.
 *
 * Credentials are resolved here rather than through `plugins/auth.ts` for two reasons. The
 * plugin's resolver is private to its closure and needs a `FastifyRequest`, which the stdio
 * transport does not have; and MCP accepts **only** API keys — a browser session's access
 * token must not drive an agent surface, because a stolen JWT would then reach tools the
 * user never chose to expose.
 */

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Scopes that have no per-server analogue. Everything else in the vocabulary is a
 * `ServerPermission`, reused verbatim: an API key must not be grantable something a subuser
 * could not be granted, and one list is easier to reason about than two that drift.
 */
export const MCP_GLOBAL_SCOPES = ['server.create'] as const;
export type McpGlobalScope = (typeof MCP_GLOBAL_SCOPES)[number];

export type McpScope = ServerPermission | McpGlobalScope;

export const MCP_SCOPES: readonly McpScope[] = [...SERVER_PERMISSIONS, ...MCP_GLOBAL_SCOPES];

export function isMcpScope(value: unknown): value is McpScope {
  return typeof value === 'string' && (MCP_SCOPES as readonly string[]).includes(value);
}

/**
 * `ApiKey.scopes` is a JSON `string[]` where empty means "everything the owning user can
 * do" — see prisma/schema.prisma. Three cases, and the difference between them matters:
 *
 * - `[]` -> `null`, the unrestricted key the create-key endpoint mints today.
 * - a list -> that set, with strings this build does not recognise dropped. A scope we
 *   cannot interpret must never widen access.
 * - unparseable -> the empty set, which denies everything. A corrupted column is not a
 *   licence; failing closed turns it into a visible outage instead of a silent grant.
 */
function parseScopes(raw: string): ReadonlySet<McpScope> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  if (parsed.length === 0) return null;
  return new Set(parsed.filter(isMcpScope));
}

// ---------------------------------------------------------------------------
// The principal
// ---------------------------------------------------------------------------

export interface McpPrincipal {
  readonly user: AuthenticatedUser;
  readonly apiKeyId: string;
  readonly apiKeyName: string;
  /** The public half (`plt_xxxxxxxx`). Safe to write into an audit row; the secret is not. */
  readonly apiKeyPrefix: string;
  /** `null` means unrestricted — the key can do whatever its owner can. */
  readonly scopes: ReadonlySet<McpScope> | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface McpCredentialMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const BEARER_PREFIX = 'Bearer ';
const API_KEY_TOUCH_INTERVAL_MS = 60_000;

/**
 * Pulls a Platter API key out of request headers.
 *
 * Both spellings are accepted because both are idiomatic somewhere: `X-API-Key` is what the
 * rest of Platter uses, and `Authorization: Bearer` is what every MCP client sends by
 * default. A bearer value that is not a `plt_` key is ignored rather than rejected here, so
 * the caller reports "no credentials" instead of "bad credentials" for a JWT.
 */
export function extractApiKey(headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const direct = headers['x-api-key'];
  const header = Array.isArray(direct) ? direct[0] : direct;
  if (typeof header === 'string' && header.length > 0) return header;

  const authorization = headers['authorization'];
  const bearer = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof bearer !== 'string' || !bearer.startsWith(BEARER_PREFIX)) return null;

  const token = bearer.slice(BEARER_PREFIX.length).trim();
  return token.startsWith('plt_') ? token : null;
}

function apiKeyPrefixOf(token: string): string | null {
  const separator = token.indexOf('.');
  if (separator < 1) return null;
  const prefix = token.slice(0, separator);
  return prefix.startsWith('plt_') ? prefix : null;
}

/**
 * "When was this key last used" is telemetry. Making an agent's tool call wait on the write
 * would be a poor trade, and one write per key per minute is enough to answer the question
 * the operator is actually asking on the API keys screen.
 */
function touchApiKey(id: string, lastUsedAt: Date | null): void {
  const now = Date.now();
  if (lastUsedAt !== null && now - lastUsedAt.getTime() < API_KEY_TOUCH_INTERVAL_MS) return;
  void prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date(now) } }).catch(() => {
    // Losing a usage timestamp is not worth failing a tool call over, and the caller has
    // no logger we are guaranteed to have here.
  });
}

/**
 * Resolves a presented API key into a principal, or throws.
 *
 * The hash is computed unconditionally so an unknown prefix and a wrong secret take the same
 * time, exactly as `plugins/auth.ts` does — the two paths must not be distinguishable by a
 * caller timing them.
 */
export async function resolveApiKeyPrincipal(
  token: string,
  meta: McpCredentialMeta = {},
): Promise<McpPrincipal> {
  const prefix = apiKeyPrefixOf(token);
  if (!prefix) throw unauthenticated('That API key is not valid.');

  const record = await prisma.apiKey.findUnique({
    where: { prefix },
    select: {
      id: true,
      name: true,
      prefix: true,
      tokenHash: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      user: { select: AUTH_USER_SELECT },
    },
  });

  const presented = sha256Hex(token);
  if (!record || !constantTimeEqual(record.tokenHash, presented)) {
    throw unauthenticated('That API key is not valid.');
  }
  if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) {
    throw tokenExpired('That API key has expired.');
  }
  if (record.user.suspended) throw forbidden('This account is suspended.');

  touchApiKey(record.id, record.lastUsedAt);

  return {
    user: toAuthenticatedUser(record.user),
    apiKeyId: record.id,
    apiKeyName: record.name,
    apiKeyPrefix: record.prefix,
    scopes: parseScopes(record.scopes),
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  };
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/**
 * Fails a call the credential itself is not allowed to make.
 *
 * Checked before anything touches the database: an under-scoped key should learn nothing
 * about which servers exist, and a rejection that costs no query is also the cheapest thing
 * to do under a key that is looping on a tool it may not call.
 */
export function assertScope(principal: McpPrincipal, scope: McpScope): void {
  if (principal.scopes === null || principal.scopes.has(scope)) return;
  throw forbidden(`This API key is not scoped for ${scope}.`);
}

/**
 * Resolves a server the principal may act on, or throws the same errors the HTTP path does.
 *
 * `notFound` — never `forbidden` — for a server the principal has no relationship to, so
 * probing ids tells an agent nothing it could not already see. That is the rule
 * `requireServerAccess` follows, and the two must not disagree.
 */
export async function authorizeServer(
  principal: McpPrincipal,
  serverId: string,
  permission: ServerPermission,
): Promise<ServerRecord> {
  assertScope(principal, permission);

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) throw notFound('server');

  const granted = await serverPermissionsFor(server, principal.user);
  if (!granted) throw notFound('server');
  if (!granted.has(permission)) {
    throw forbidden('You do not have permission to do that on this server.');
  }
  return server;
}

// ---------------------------------------------------------------------------
// Identity for the audit log
// ---------------------------------------------------------------------------

/** Audit `actorName` is a column, not a document; this keeps a hostile client name bounded. */
const MAX_ACTOR_NAME = 120;

/**
 * Names the agent in an audit row.
 *
 * All three parts are load-bearing when someone later asks "who did this": the MCP client
 * that made the call, the human account it acted as, and the key that carried it — which is
 * the only one of the three that can be revoked.
 */
export function principalLabel(principal: McpPrincipal, clientName: string | null): string {
  const client = (clientName ?? 'MCP client').replace(/\s+/g, ' ').trim() || 'MCP client';
  const label = `${client} (${principal.user.displayName} via key ${principal.apiKeyPrefix})`;
  return label.length > MAX_ACTOR_NAME ? `${label.slice(0, MAX_ACTOR_NAME - 1)}…` : label;
}
