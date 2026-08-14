import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  apiKeySchema,
  authResponseSchema,
  changePasswordRequestSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  emailSchema,
  idSchema,
  loginRequestSchema,
  okSchema,
  registerRequestSchema,
  sessionUserSchema,
  totpConfirmRequestSchema,
  totpSetupResponseSchema,
  updateProfileRequestSchema,
  type SessionUser,
  type UserRole,
} from '@platter/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import {
  alreadyExists,
  badRequest,
  forbidden,
  invalidCredentials,
  notFound,
  tokenExpired,
  unauthenticated,
} from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { dummyVerify, hashPassword, verifyPassword } from '../lib/password.js';
import { parseScopes } from '../lib/scopes.js';
import {
  buildOtpauthUrl,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotp,
} from '../lib/totp.js';
import {
  AUTH_USER_SELECT,
  REFRESH_COOKIE_NAME,
  generateApiKey,
  refreshCookieOptions,
  toAuthenticatedUser,
  type AuthContext,
  type AuthenticatedUser,
} from '../plugins/auth.js';
import { AUTH_RATE_LIMIT, SENSITIVE_RATE_LIMIT } from '../plugins/security.js';
import { recordAudit, recordAuditFromRequest } from '../services/audit.js';

/** Palette used for generated avatars — picked to stay legible on both themes. */
const AVATAR_COLORS = ['#5b8def', '#e0654f', '#3fa66a', '#c07ad6', '#d99b3a', '#3fa8b8'] as const;

function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

function toSessionUser(user: AuthenticatedUser): SessionUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    avatarColor: user.avatarColor,
    totpEnabled: user.totpEnabled,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

/** The current principal, or a 401. Every authenticated handler below starts here. */
function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/**
 * API keys deliberately cannot manage credentials. A leaked key would otherwise be able to
 * change the account's password or mint more keys, turning a scoped credential into a full
 * account takeover.
 */
function requireInteractiveSession(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (auth.via !== 'jwt') {
    throw forbidden('Sign in with your password to change account security settings.');
  }
  return auth;
}

function requestMeta(request: FastifyRequest): { userAgent: string | null; ip: string } {
  return { userAgent: request.headers['user-agent'] ?? null, ip: request.ip };
}

/**
 * Issues the pair: refresh token into an httpOnly cookie the browser cannot read, access
 * token in the body for the SPA to hold in memory. Splitting them means XSS cannot steal a
 * long-lived credential and CSRF cannot use the short-lived one.
 */
async function completeLogin(
  app: FastifyInstance,
  reply: FastifyReply,
  request: FastifyRequest,
  user: AuthenticatedUser,
): Promise<{ user: SessionUser; accessToken: string; expiresIn: number }> {
  const refresh = await app.issueRefreshToken(user, requestMeta(request));
  reply.setCookie(REFRESH_COOKIE_NAME, refresh.token, refreshCookieOptions());
  return {
    user: toSessionUser(user),
    accessToken: app.issueAccessToken(user),
    expiresIn: config.accessTokenTtlSeconds,
  };
}

function parseRecoveryHashes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  // Token helpers live on the untyped instance; `fastify` is the exact `FastifyInstance`
  // they were declared against, while `app` only exists to type route schemas.

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  app.post(
    '/login',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Exchange credentials for an access token',
        security: [],
        body: loginRequestSchema,
        response: { 200: authResponseSchema },
      },
    },
    async (request, reply) => {
      const { email, password, totp } = request.body;
      const user = await prisma.user.findUnique({ where: { email } });

      if (!user) {
        // Same work as a real verify, so response time cannot be used to enumerate accounts.
        await dummyVerify();
        await recordAudit({
          action: 'auth.login_failed',
          targetType: 'user',
          // The claimed identity is the actor here, even though it authenticated nothing —
          // an operator reading the feed wants to see which account was targeted.
          actorName: email,
          targetName: email,
          metadata: { reason: 'unknown_email' },
          ...requestMeta(request),
          logger: request.log,
        });
        throw invalidCredentials();
      }

      const passwordOk = await verifyPassword(user.passwordHash, password);
      if (!passwordOk) {
        await recordAudit({
          action: 'auth.login_failed',
          targetType: 'user',
          actorId: user.id,
          actorName: user.displayName,
          targetId: user.id,
          targetName: user.email,
          metadata: { reason: 'bad_password' },
          ...requestMeta(request),
          logger: request.log,
        });
        throw invalidCredentials();
      }

      if (user.suspended) {
        await recordAudit({
          action: 'auth.login_failed',
          targetType: 'user',
          actorId: user.id,
          actorName: user.displayName,
          targetId: user.id,
          targetName: user.email,
          metadata: { reason: 'suspended' },
          ...requestMeta(request),
          logger: request.log,
        });
        throw forbidden('This account is suspended.');
      }

      if (user.totpEnabled) {
        // The `details` key tells the client to show the code field. It does reveal that
        // the password was correct, which is unavoidable: a second factor cannot be
        // requested without admitting the first one passed.
        if (!totp) {
          throw invalidCredentials('Enter the code from your authenticator app.', {
            totp: ['A six-digit code is required.'],
          });
        }
        // The step is spent below, before the session is issued: a code replayed inside
        // its own 90-second window is not a second successful login.
        const step = user.totpSecret ? verifyTotp(user.totpSecret, totp, user.lastTotpStep) : null;
        if (step === null) {
          await recordAudit({
            action: 'auth.login_failed',
            targetType: 'user',
            actorId: user.id,
            actorName: user.displayName,
            targetId: user.id,
            targetName: user.email,
            metadata: { reason: 'bad_totp' },
            ...requestMeta(request),
            logger: request.log,
          });
          throw invalidCredentials('That code is not valid.', {
            totp: ['Check the code and try again.'],
          });
        }
        // Guarded on the value we read, so two logins racing the same code cannot both
        // record it — the loser's update matches nothing and it is refused.
        const spent = await prisma.user.updateMany({
          where: { id: user.id, lastTotpStep: user.lastTotpStep },
          data: { lastTotpStep: step },
        });
        if (spent.count === 0) {
          throw invalidCredentials('That code has already been used.', {
            totp: ['Wait for your authenticator to show the next code.'],
          });
        }
      }

      const authenticated = toAuthenticatedUser(
        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
          select: AUTH_USER_SELECT,
        }),
      );

      await recordAudit({
        action: 'auth.login',
        targetType: 'user',
        actorId: authenticated.id,
        actorName: authenticated.displayName,
        targetId: authenticated.id,
        targetName: authenticated.email,
        ...requestMeta(request),
        logger: request.log,
      });

      return completeLogin(fastify, reply, request, authenticated);
    },
  );

  app.post(
    '/register',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Create an account',
        description:
          'Open only when registration is enabled, or when no account exists yet. The first account is always created as `owner`.',
        security: [],
        body: registerRequestSchema,
        response: { 201: authResponseSchema },
      },
    },
    async (request, reply) => {
      const { email, username, displayName, password } = request.body;

      const existingUsers = await prisma.user.count();
      const isBootstrap = existingUsers === 0;
      if (!isBootstrap && !config.registrationEnabled) {
        throw forbidden('Registration is closed. Ask an administrator for an invite.');
      }

      const clash = await prisma.user.findFirst({
        where: { OR: [{ email }, { username }] },
        select: { email: true },
      });
      if (clash) throw alreadyExists(clash.email === email ? 'email' : 'username');

      // Whoever installs Platter owns it. Every later account starts as a member.
      const role: UserRole = isBootstrap ? 'owner' : 'member';

      const created = await prisma.user.create({
        data: {
          id: newId('usr'),
          email,
          username,
          displayName,
          passwordHash: await hashPassword(password),
          role,
          avatarColor: pickAvatarColor(username),
          lastLoginAt: new Date(),
        },
        select: AUTH_USER_SELECT,
      });
      const user = toAuthenticatedUser(created);

      await recordAudit({
        action: 'user.created',
        targetType: 'user',
        actorId: user.id,
        actorName: user.displayName,
        targetId: user.id,
        targetName: user.email,
        metadata: { role, bootstrap: isBootstrap },
        ...requestMeta(request),
        logger: request.log,
      });

      const body = await completeLogin(fastify, reply, request, user);
      return reply.status(201).send(body);
    },
  );

  app.post(
    '/refresh',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Rotate the refresh cookie and mint a new access token',
        security: [],
        response: { 200: authResponseSchema },
      },
    },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE_NAME];
      if (!token) throw tokenExpired('You are not signed in.');

      let rotated;
      try {
        rotated = await fastify.rotateRefreshToken(token, requestMeta(request));
      } catch (error) {
        // The cookie is dead either way; clearing it stops the client from retrying with
        // it forever and keeps the browser's state honest.
        reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));
        throw error;
      }

      reply.setCookie(REFRESH_COOKIE_NAME, rotated.token, refreshCookieOptions());
      return {
        user: toSessionUser(rotated.user),
        accessToken: fastify.issueAccessToken(rotated.user),
        expiresIn: config.accessTokenTtlSeconds,
      };
    },
  );

  app.post(
    '/logout',
    {
      // Optional: signing out works without a valid access token, but resolving one lets
      // the audit entry name who did it.
      preHandler: app.tryAuthenticate,
      schema: {
        tags: ['auth'],
        summary: 'Revoke the current refresh token',
        security: [],
        response: { 200: okSchema },
      },
    },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE_NAME];
      if (token) await fastify.revokeRefreshToken(token);
      reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));

      if (request.auth) {
        await recordAuditFromRequest(request, {
          action: 'auth.logout',
          targetType: 'user',
          targetId: request.auth.user.id,
          targetName: request.auth.user.email,
        });
      }
      // Always 200: signing out of a session that is already gone is a success.
      return { ok: true as const };
    },
  );

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  /**
   * Every authenticated route below uses `requireAccount`, not `authenticate`.
   *
   * `requireInteractiveSession` already kept API keys away from the password and TOTP
   * endpoints, but it was applied handler by handler and `PATCH /me` was missed — so a key
   * scoped to nothing but `server.view` could rewrite the account's email, and login is by
   * email. `requireAccount` refuses every restricted key across the whole prefix, which is
   * the version of this rule that cannot be forgotten on the next endpoint added here.
   * An unrestricted key still passes, and still meets `requireInteractiveSession` where a
   * credential change genuinely needs a password behind it.
   */

  app.get(
    '/me',
    {
      preHandler: app.requireAccount,
      schema: {
        tags: ['auth'],
        summary: 'The signed-in user',
        response: { 200: sessionUserSchema },
      },
    },
    async (request) => toSessionUser(requireAuth(request).user),
  );

  app.patch(
    '/me',
    {
      preHandler: app.requireAccount,
      schema: {
        tags: ['auth'],
        summary: 'Update your own profile',
        body: updateProfileRequestSchema,
        response: { 200: sessionUserSchema },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const { displayName, email, avatarColor } = request.body;

      if (email !== undefined && email !== user.email) {
        const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (taken) throw alreadyExists('email');
      }

      const updated = toAuthenticatedUser(
        await prisma.user.update({
          where: { id: user.id },
          data: {
            ...(displayName !== undefined ? { displayName } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(avatarColor !== undefined ? { avatarColor } : {}),
          },
          select: AUTH_USER_SELECT,
        }),
      );

      await recordAuditFromRequest(request, {
        action: 'user.updated',
        targetType: 'user',
        targetId: user.id,
        targetName: updated.email,
        metadata: { fields: Object.keys(request.body) },
      });

      return toSessionUser(updated);
    },
  );

  app.post(
    '/password',
    {
      preHandler: app.requireAccount,
      config: { rateLimit: SENSITIVE_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Change your password',
        body: changePasswordRequestSchema,
        response: { 200: okSchema },
      },
    },
    async (request, reply) => {
      const { user } = requireInteractiveSession(request);
      const { currentPassword, newPassword } = request.body;

      const record = await prisma.user.findUnique({
        where: { id: user.id },
        select: { passwordHash: true },
      });
      if (!record) throw unauthenticated();
      if (!(await verifyPassword(record.passwordHash, currentPassword))) {
        throw invalidCredentials('That is not your current password.', {
          currentPassword: ['Incorrect password.'],
        });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(newPassword) },
      });

      // A password change is how someone reacts to a suspected compromise, so every other
      // session dies with it — including whatever the attacker was holding.
      await fastify.revokeAllRefreshTokens(user.id);
      reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));

      await recordAuditFromRequest(request, {
        action: 'auth.password_changed',
        targetType: 'user',
        targetId: user.id,
        targetName: user.email,
      });

      return { ok: true as const };
    },
  );

  // -------------------------------------------------------------------------
  // Two-factor authentication
  // -------------------------------------------------------------------------

  app.post(
    '/totp/setup',
    {
      preHandler: app.requireAccount,
      config: { rateLimit: SENSITIVE_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Begin two-factor enrolment',
        description:
          'Stores an unconfirmed secret and returns it with recovery codes. 2FA is not enforced until `POST /auth/totp/confirm` succeeds.',
        response: { 200: totpSetupResponseSchema },
      },
    },
    async (request) => {
      const { user } = requireInteractiveSession(request);
      if (user.totpEnabled) {
        throw badRequest('Two-factor authentication is already on. Turn it off first.');
      }

      const secret = generateTotpSecret();
      const recoveryCodes = generateRecoveryCodes();

      // Written but not enabled: an interrupted enrolment must not lock the account.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          totpSecret: secret,
          recoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)),
        },
      });

      return {
        secret,
        otpauthUrl: buildOtpauthUrl(secret, user.email),
        // The only time the plaintext codes exist anywhere. Only their hashes are stored.
        recoveryCodes,
      };
    },
  );

  app.post(
    '/totp/confirm',
    {
      preHandler: app.requireAccount,
      config: { rateLimit: SENSITIVE_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Finish two-factor enrolment',
        body: totpConfirmRequestSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const { user } = requireInteractiveSession(request);
      const record = await prisma.user.findUnique({
        where: { id: user.id },
        select: { totpSecret: true, totpEnabled: true, lastTotpStep: true },
      });
      if (!record?.totpSecret) throw badRequest('Start two-factor setup first.');
      if (record.totpEnabled) throw badRequest('Two-factor authentication is already on.');
      const step = verifyTotp(record.totpSecret, request.body.token, record.lastTotpStep);
      if (step === null) {
        throw invalidCredentials('That code is not valid.', {
          token: ['Check your authenticator app and try again.'],
        });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { totpEnabled: true, lastTotpStep: step },
      });
      await recordAuditFromRequest(request, {
        action: 'auth.totp_enabled',
        targetType: 'user',
        targetId: user.id,
        targetName: user.email,
      });

      return { ok: true as const };
    },
  );

  app.delete(
    '/totp',
    {
      preHandler: app.requireAccount,
      config: { rateLimit: SENSITIVE_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Turn off two-factor authentication',
        description:
          'Requires a current code, so a hijacked access token alone cannot remove the second factor.',
        body: totpConfirmRequestSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const { user } = requireInteractiveSession(request);
      const record = await prisma.user.findUnique({
        where: { id: user.id },
        select: { totpSecret: true, totpEnabled: true, lastTotpStep: true },
      });
      if (!record?.totpEnabled || !record.totpSecret) {
        throw badRequest('Two-factor authentication is not on.');
      }
      if (verifyTotp(record.totpSecret, request.body.token, record.lastTotpStep) === null) {
        throw invalidCredentials('That code is not valid.', {
          token: ['Check your authenticator app and try again.'],
        });
      }

      // `lastTotpStep` is cleared alongside the secret: a future enrolment mints a new
      // secret, and a step counter from the old one would reject its first codes.
      await prisma.user.update({
        where: { id: user.id },
        data: { totpEnabled: false, totpSecret: null, recoveryCodes: '[]', lastTotpStep: null },
      });
      await recordAuditFromRequest(request, {
        action: 'auth.totp_disabled',
        targetType: 'user',
        targetId: user.id,
        targetName: user.email,
      });

      return { ok: true as const };
    },
  );

  app.post(
    '/totp/recover',
    {
      config: { rateLimit: SENSITIVE_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Sign in with a recovery code',
        description:
          'For when the authenticator is gone. Consumes the code and signs in; two-factor stays on so the remaining codes keep working.',
        security: [],
        body: z.object({
          email: emailSchema,
          password: z.string().min(1),
          recoveryCode: z.string().min(4).max(32),
        }),
        response: { 200: authResponseSchema },
      },
    },
    async (request, reply) => {
      const { email, password, recoveryCode } = request.body;
      const user = await prisma.user.findUnique({ where: { email } });

      if (!user) {
        await dummyVerify();
        throw invalidCredentials();
      }
      if (!(await verifyPassword(user.passwordHash, password))) throw invalidCredentials();
      if (user.suspended) throw forbidden('This account is suspended.');
      if (!user.totpEnabled)
        throw badRequest('Two-factor authentication is not on for this account.');

      const hashes = parseRecoveryHashes(user.recoveryCodes);
      const presented = hashRecoveryCode(recoveryCode);
      const remaining = hashes.filter((hash) => hash !== presented);
      if (remaining.length === hashes.length) {
        await recordAudit({
          action: 'auth.login_failed',
          targetType: 'user',
          actorId: user.id,
          actorName: user.displayName,
          targetId: user.id,
          targetName: user.email,
          metadata: { reason: 'bad_recovery_code' },
          ...requestMeta(request),
          logger: request.log,
        });
        throw invalidCredentials('That recovery code is not valid.');
      }

      // Single use: consumed in the same write that records the login.
      const authenticated = toAuthenticatedUser(
        await prisma.user.update({
          where: { id: user.id },
          data: { recoveryCodes: JSON.stringify(remaining), lastLoginAt: new Date() },
          select: AUTH_USER_SELECT,
        }),
      );

      await recordAudit({
        action: 'auth.login',
        targetType: 'user',
        actorId: authenticated.id,
        actorName: authenticated.displayName,
        targetId: authenticated.id,
        targetName: authenticated.email,
        metadata: { method: 'recovery_code', codesRemaining: remaining.length },
        ...requestMeta(request),
        logger: request.log,
      });

      return completeLogin(fastify, reply, request, authenticated);
    },
  );

  // -------------------------------------------------------------------------
  // API keys
  // -------------------------------------------------------------------------

  app.get(
    '/keys',
    {
      preHandler: app.requireAccount,
      schema: {
        tags: ['auth'],
        summary: 'List your API keys',
        response: { 200: z.array(apiKeySchema) },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const keys = await prisma.apiKey.findMany({
        where: { userId: user.id },
        orderBy: { id: 'desc' },
      });
      return keys.map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: [...(parseScopes(key.scopes) ?? [])],
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        expiresAt: key.expiresAt?.toISOString() ?? null,
        createdAt: key.createdAt.toISOString(),
      }));
    },
  );

  app.post(
    '/keys',
    {
      preHandler: app.requireAccount,
      config: { rateLimit: SENSITIVE_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Create an API key',
        description: 'The plaintext token is in the response and is never retrievable again.',
        body: createApiKeyRequestSchema,
        response: { 201: createApiKeyResponseSchema },
      },
    },
    async (request, reply) => {
      const { user } = requireInteractiveSession(request);
      const { name, scopes, expiresInDays } = request.body;

      const { token, prefix, tokenHash } = generateApiKey();
      const expiresAt =
        expiresInDays === null ? null : new Date(Date.now() + expiresInDays * 86_400_000);

      // De-duplicated so the stored list is the set it is read back as, and the audit row
      // records the grant: which scopes a key carries is the whole of what it can do.
      const granted = [...new Set(scopes)];
      const created = await prisma.apiKey.create({
        data: {
          id: newId('key'),
          userId: user.id,
          name,
          prefix,
          tokenHash,
          scopes: JSON.stringify(granted),
          expiresAt,
        },
      });

      await recordAuditFromRequest(request, {
        action: 'apikey.created',
        targetType: 'apikey',
        targetId: created.id,
        targetName: name,
        metadata: { prefix, scopes: granted, expiresAt: expiresAt?.toISOString() ?? null },
      });

      return reply.status(201).send({
        id: created.id,
        name: created.name,
        prefix: created.prefix,
        scopes: granted,
        lastUsedAt: null,
        expiresAt: created.expiresAt?.toISOString() ?? null,
        createdAt: created.createdAt.toISOString(),
        token,
      });
    },
  );

  app.delete(
    '/keys/:keyId',
    {
      preHandler: app.requireAccount,
      schema: {
        tags: ['auth'],
        summary: 'Revoke an API key',
        params: z.object({ keyId: idSchema }),
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const { user } = requireInteractiveSession(request);
      const { keyId } = request.params;

      // Scoped to the caller, so guessing another user's key id returns the same 404 as a
      // key that never existed.
      const key = await prisma.apiKey.findFirst({
        where: { id: keyId, userId: user.id },
        select: { id: true, name: true, prefix: true },
      });
      if (!key) throw notFound('API key');

      await prisma.apiKey.delete({ where: { id: key.id } });
      await recordAuditFromRequest(request, {
        action: 'apikey.revoked',
        targetType: 'apikey',
        targetId: key.id,
        targetName: key.name,
        metadata: { prefix: key.prefix },
      });

      return { ok: true as const };
    },
  );
};

export default authRoutes;
