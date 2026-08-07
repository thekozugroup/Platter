import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import type { Server as ServerRecord } from '@prisma/client';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  API_PREFIX,
  SERVER_PERMISSIONS,
  roleAtLeast,
  type ServerPermission,
  type UserRole,
} from '@platter/shared';
import { config, isProduction } from '../config.js';
import { prisma } from '../db.js';
import { forbidden, internal, notFound, tokenExpired, unauthenticated } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { constantTimeEqual, randomToken, sha256Hex } from '../lib/password.js';

/** The projection of a user that is safe to hang off a request. Never carries secrets. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: UserRole;
  avatarColor: string;
  totpEnabled: boolean;
  suspended: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface AuthContext {
  user: AuthenticatedUser;
  via: 'jwt' | 'apikey';
  /** Set only for `apikey`, so audit entries can name the key that acted. */
  apiKeyId: string | null;
}

export interface RefreshTokenMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedRefreshToken {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export interface RotatedRefreshToken extends IssuedRefreshToken {
  user: AuthenticatedUser;
}

interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  /** Distinguishes access tokens from anything else we might ever sign with this key. */
  typ: 'access';
}

export type { ServerRecord };

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `authenticate` / `requireRole` / `requireServerAccess`; null otherwise. */
    auth: AuthContext | null;
    /**
     * The server resolved by `requireServerAccess`, so handlers do not refetch it.
     * Not named `server`: Fastify already owns `request.server` (the instance).
     */
    gameServer: ServerRecord | null;
  }

  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    /** Resolves credentials when present and never rejects — for routes with optional auth. */
    tryAuthenticate: preHandlerHookHandler;
    requireRole(minimum: UserRole): preHandlerHookHandler;
    requireServerAccess(permission: ServerPermission): preHandlerHookHandler;

    issueAccessToken(user: AuthenticatedUser): string;
    issueRefreshToken(user: AuthenticatedUser, meta?: RefreshTokenMeta): Promise<IssuedRefreshToken>;
    rotateRefreshToken(token: string, meta?: RefreshTokenMeta): Promise<RotatedRefreshToken>;
    revokeRefreshToken(token: string): Promise<void>;
    revokeAllRefreshTokens(userId: string): Promise<void>;
    /** Verifies an access token off the wire (the console socket's `auth` frame). */
    verifySocketToken(token: string): Promise<AuthContext>;
  }
}

/** Selection shared by every path that materialises an `AuthenticatedUser`. */
export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  role: true,
  avatarColor: true,
  totpEnabled: true,
  suspended: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

interface UserRow {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: string;
  avatarColor: string;
  totpEnabled: boolean;
  suspended: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const VALID_ROLES: readonly string[] = ['owner', 'admin', 'member'];

/**
 * Roles are stored as strings because SQLite has no enums, so the union is re-established
 * here on the way out. A row with an unrecognised role is a corrupted row, and treating it
 * as `member` would silently grant it more than nothing.
 */
export function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  if (!VALID_ROLES.includes(row.role)) {
    throw internal(`User ${row.id} has an unrecognised role`);
  }
  return { ...row, role: row.role as UserRole };
}

export const REFRESH_COOKIE_NAME = 'platter_refresh';

/** Scoped to the auth routes: no other endpoint has any use for the refresh token. */
export const REFRESH_COOKIE_PATH = `${API_PREFIX}/auth`;

const API_KEY_HEADER = 'x-api-key';
const BEARER_PREFIX = 'Bearer ';

/**
 * `plt_xxxxxxxx.<secret>` — the part before the dot is stored in the clear and indexed, so
 * a presented key costs one lookup, and the secret half is compared against a digest.
 */
const API_KEY_PREFIX_BYTES = 6;
const API_KEY_SECRET_BYTES = 32;

export interface GeneratedApiKey {
  token: string;
  prefix: string;
  tokenHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = `plt_${randomToken(API_KEY_PREFIX_BYTES)}`;
  const token = `${prefix}.${randomToken(API_KEY_SECRET_BYTES)}`;
  return { token, prefix, tokenHash: sha256Hex(token) };
}

function apiKeyPrefixOf(token: string): string | null {
  const separator = token.indexOf('.');
  if (separator < 1) return null;
  const prefix = token.slice(0, separator);
  return prefix.startsWith('plt_') ? prefix : null;
}

/** One write per key per minute at most, instead of one per request. */
const API_KEY_TOUCH_INTERVAL_MS = 60_000;

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function isExpiredJwtError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  // fast-jwt raises the first; @fastify/jwt re-wraps it as the second.
  return code === 'FAST_JWT_EXPIRED' || code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED';
}

async function loadAuthUser(userId: string): Promise<AuthenticatedUser | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: AUTH_USER_SELECT });
  return row ? toAuthenticatedUser(row) : null;
}

const authPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.accessTokenTtl },
  });

  app.decorateRequest('auth', null);
  app.decorateRequest('gameServer', null);

  // -------------------------------------------------------------------------
  // Credential resolution
  // -------------------------------------------------------------------------

  function verifyAccessToken(token: string): AccessTokenPayload {
    let payload: AccessTokenPayload;
    try {
      payload = app.jwt.verify<AccessTokenPayload>(token);
    } catch (error) {
      throw isExpiredJwtError(error) ? tokenExpired() : unauthenticated('That token is not valid.');
    }
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') {
      throw unauthenticated('That token is not valid.');
    }
    return payload;
  }

  async function resolveJwt(token: string): Promise<AuthContext> {
    const payload = verifyAccessToken(token);
    const user = await loadAuthUser(payload.sub);
    // The token is signed and unexpired but the account is gone: treat it as no
    // credentials at all rather than as a server error.
    if (!user) throw unauthenticated('That token is not valid.');
    if (user.suspended) throw forbidden('This account is suspended.');
    return { user, via: 'jwt', apiKeyId: null };
  }

  async function resolveApiKey(token: string): Promise<AuthContext> {
    const prefix = apiKeyPrefixOf(token);
    if (!prefix) throw unauthenticated('That API key is not valid.');

    const record = await prisma.apiKey.findUnique({
      where: { prefix },
      select: {
        id: true,
        tokenHash: true,
        expiresAt: true,
        lastUsedAt: true,
        user: { select: AUTH_USER_SELECT },
      },
    });

    // Hash unconditionally so a wrong prefix and a wrong secret take the same time.
    const presented = sha256Hex(token);
    if (!record || !constantTimeEqual(record.tokenHash, presented)) {
      throw unauthenticated('That API key is not valid.');
    }
    if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) {
      throw tokenExpired('That API key has expired.');
    }
    if (record.user.suspended) throw forbidden('This account is suspended.');

    touchApiKey(record.id, record.lastUsedAt);
    return { user: toAuthenticatedUser(record.user), via: 'apikey', apiKeyId: record.id };
  }

  /**
   * Deliberately not awaited: "when was this key last used" is telemetry, and making every
   * API request wait on a write to record it would be a poor trade.
   */
  function touchApiKey(id: string, lastUsedAt: Date | null): void {
    const now = Date.now();
    if (lastUsedAt !== null && now - lastUsedAt.getTime() < API_KEY_TOUCH_INTERVAL_MS) return;

    void prisma.apiKey
      .update({ where: { id }, data: { lastUsedAt: new Date(now) } })
      .catch((error: unknown) => {
        app.log.warn({ err: error, apiKeyId: id }, 'failed to record API key usage');
      });
  }

  async function resolveAuth(request: FastifyRequest): Promise<AuthContext | null> {
    const apiKey = request.headers[API_KEY_HEADER];
    if (typeof apiKey === 'string' && apiKey.length > 0) return resolveApiKey(apiKey);

    const bearer = extractBearerToken(request);
    if (bearer) return resolveJwt(bearer);

    return null;
  }

  /**
   * Idempotent so `requireRole` and `requireServerAccess` work whether or not
   * `authenticate` also ran — a route that lists both preHandlers pays for one lookup.
   */
  async function ensureAuth(request: FastifyRequest): Promise<AuthContext> {
    if (request.auth) return request.auth;
    const auth = await resolveAuth(request);
    if (!auth) throw unauthenticated();
    request.auth = auth;
    return auth;
  }

  const authenticate: preHandlerHookHandler = async (request) => {
    await ensureAuth(request);
  };
  app.decorate('authenticate', authenticate);

  const tryAuthenticate: preHandlerHookHandler = async (request) => {
    if (request.auth) return;
    try {
      request.auth = await resolveAuth(request);
    } catch {
      // Bad credentials on an optional-auth route are the same as no credentials: the
      // route decides what an anonymous caller sees.
      request.auth = null;
    }
  };
  app.decorate('tryAuthenticate', tryAuthenticate);

  app.decorate('requireRole', (minimum: UserRole): preHandlerHookHandler => {
    const handler: preHandlerHookHandler = async (request) => {
      const { user } = await ensureAuth(request);
      if (!roleAtLeast(user.role, minimum)) throw forbidden();
    };
    return handler;
  });

  // -------------------------------------------------------------------------
  // Per-server authorisation
  // -------------------------------------------------------------------------

  function parsePermissions(raw: string, serverId: string): ServerPermission[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      app.log.error({ serverId }, 'subuser permissions column is not valid JSON');
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    // Unknown strings are dropped rather than trusted: a permission this build does not
    // recognise must never widen access.
    return parsed.filter((value): value is ServerPermission =>
      typeof value === 'string' && (SERVER_PERMISSIONS as readonly string[]).includes(value),
    );
  }

  app.decorate('requireServerAccess', (permission: ServerPermission): preHandlerHookHandler => {
    const handler: preHandlerHookHandler = async (request) => {
      const { user } = await ensureAuth(request);

      const params = request.params as Record<string, unknown> | undefined;
      const serverId = params?.['serverId'];
      // A malformed id is answered exactly like a missing server, so probing the route
      // with junk tells an attacker nothing.
      if (typeof serverId !== 'string' || serverId.length === 0) throw notFound('server');

      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw notFound('server');

      const isAdmin = roleAtLeast(user.role, 'admin');
      if (!isAdmin && server.ownerId !== user.id) {
        const subuser = await prisma.serverSubuser.findUnique({
          where: { serverId_userId: { serverId: server.id, userId: user.id } },
          select: { permissions: true },
        });
        // No relationship at all: 404, not 403. A 403 would confirm the server exists.
        if (!subuser) throw notFound('server');
        if (!parsePermissions(subuser.permissions, server.id).includes(permission)) {
          throw forbidden('You do not have permission to do that on this server.');
        }
      }

      request.gameServer = server;
    };
    return handler;
  });

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  app.decorate('issueAccessToken', (user: AuthenticatedUser): string => {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role, typ: 'access' };
    return app.jwt.sign(payload);
  });

  async function createSession(
    user: AuthenticatedUser,
    familyId: string,
    meta: RefreshTokenMeta | undefined,
  ): Promise<IssuedRefreshToken> {
    const token = randomToken();
    const sessionId = newId('ses');
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlSeconds * 1000);

    await prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        tokenHash: sha256Hex(token),
        familyId,
        userAgent: meta?.userAgent ?? null,
        ip: meta?.ip ?? null,
        expiresAt,
      },
    });

    return { token, sessionId, expiresAt };
  }

  app.decorate(
    'issueRefreshToken',
    async (user: AuthenticatedUser, meta?: RefreshTokenMeta): Promise<IssuedRefreshToken> => {
      // A fresh login starts a new family, so revoking one compromised chain does not sign
      // the user out of their other devices.
      return createSession(user, newId('ses'), meta);
    },
  );

  app.decorate(
    'rotateRefreshToken',
    async (token: string, meta?: RefreshTokenMeta): Promise<RotatedRefreshToken> => {
      const tokenHash = sha256Hex(token);
      const session = await prisma.session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          familyId: true,
          revokedAt: true,
          expiresAt: true,
          user: { select: AUTH_USER_SELECT },
        },
      });

      if (!session) throw tokenExpired();

      if (session.revokedAt !== null) {
        // A rotated token being presented again means either a replay or a stolen cookie
        // that raced the legitimate client. We cannot tell which, so the whole chain of
        // tokens descended from that login is burned and the user re-authenticates.
        await prisma.session.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        app.log.warn({ familyId: session.familyId }, 'refresh token reuse detected; family revoked');
        throw tokenExpired();
      }

      if (session.expiresAt.getTime() <= Date.now()) throw tokenExpired();

      const user = toAuthenticatedUser(session.user);
      if (user.suspended) throw forbidden('This account is suspended.');

      await prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      const issued = await createSession(user, session.familyId, meta);
      return { ...issued, user };
    },
  );

  app.decorate('revokeRefreshToken', async (token: string): Promise<void> => {
    // updateMany, not update: signing out twice, or with a token we never issued, is a
    // no-op rather than a 404.
    await prisma.session.updateMany({
      where: { tokenHash: sha256Hex(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  app.decorate('revokeAllRefreshTokens', async (userId: string): Promise<void> => {
    await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  app.decorate('verifySocketToken', async (token: string): Promise<AuthContext> => {
    return resolveJwt(token);
  });
};

/**
 * The server `requireServerAccess` loaded, for handlers that ran behind it.
 *
 * It throws rather than returning null so a route that forgot the preHandler fails loudly
 * instead of quietly serving an unauthorised request.
 */
export function requireServer(request: FastifyRequest): ServerRecord {
  if (!request.gameServer) {
    throw internal('requireServerAccess did not run for this route');
  }
  return request.gameServer;
}

/**
 * Standalone form for callers that hold an instance but not a request — the console socket
 * verifies its `auth` frame outside any route's preHandler chain.
 */
export function verifySocketToken(app: FastifyInstance, token: string): Promise<AuthContext> {
  return app.verifySocketToken(token);
}

/** Cookie options for the refresh token, shared by login, refresh and logout. */
export function refreshCookieOptions(maxAgeSeconds: number = config.refreshTokenTtlSeconds): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Lax, not Strict: the SPA is same-origin, and Strict would drop the cookie on a
    // top-level navigation back into Platter from an external link.
    sameSite: 'lax',
    secure: isProduction,
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

export default Object.assign(authPlugin, {
  // Marks the plugin as non-encapsulated — the same thing `fastify-plugin` does, written
  // out because it is not a dependency of this package. Without it every decorator below
  // would be scoped to this plugin's own context and invisible to the routes.
  [Symbol.for('skip-override')]: true,
});
