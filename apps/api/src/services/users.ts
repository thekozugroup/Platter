import type { Prisma, User as UserRow } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  ROLE_RANK,
  SERVER_STATUSES,
  canPerformPowerAction,
  type Paginated,
  type PowerAction,
  type ServerStatus,
  type User,
  type UserRole,
} from '@platter/shared';
import { prisma } from '../db.js';
import { alreadyExists, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import type { AuthenticatedUser } from '../plugins/auth.js';
import { performPowerAction } from './lifecycle.js';

/**
 * Admin-facing user management. Everything here assumes its caller already passed
 * `requireRole('admin')` — this module enforces the *relative* rules a route-level role
 * check cannot (rank-vs-rank, the last-owner invariant), not "is this caller an admin".
 */

/**
 * Same palette and hash as `routes/auth.ts`'s `pickAvatarColor`, kept as its own copy: that
 * function is not exported (auth.ts is frozen), and an admin creating an account should get
 * the same deterministic-by-username look a self-registered one would.
 */
const AVATAR_COLORS = ['#5b8def', '#e0654f', '#3fa66a', '#c07ad6', '#d99b3a', '#3fa8b8'] as const;

function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

function isServerStatus(value: string): value is ServerStatus {
  return (SERVER_STATUSES as readonly string[]).includes(value);
}

function toUserDto(row: UserRow, serverCount: number): User {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.displayName,
    role: row.role as UserRole,
    avatarColor: row.avatarColor,
    totpEnabled: row.totpEnabled,
    suspended: row.suspended,
    serverCount,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function serverCountOf(userId: string): Promise<number> {
  return prisma.server.count({ where: { ownerId: userId } });
}

/** Nobody may act on an account that currently outranks them — not just "not escalate". */
function assertCanAct(actor: AuthenticatedUser, target: { role: string }): void {
  const targetRank = ROLE_RANK[target.role as UserRole] ?? 0;
  if (targetRank > ROLE_RANK[actor.role]) {
    throw forbidden("You don't have access to this account.");
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ListUsersQuery {
  page: number;
  perPage: number;
  search?: string;
  role?: UserRole;
  suspended?: boolean;
}

export async function listUsers(query: ListUsersQuery): Promise<Paginated<User>> {
  const where: Prisma.UserWhereInput = {};
  if (query.role !== undefined) where.role = query.role;
  if (query.suspended !== undefined) where.suspended = query.suspended;
  if (query.search !== undefined && query.search.length > 0) {
    // Email and username are always stored lower-case (see the shared schemas), so
    // lower-casing the term here makes those two comparisons effectively
    // case-insensitive. `displayName` has no such constraint and SQLite's `contains`
    // has no `mode: 'insensitive'` (that is Postgres/Mongo only), so a search that only
    // differs from a display name by case will miss it — a small, documented gap rather
    // than a query that throws on this provider.
    const term = query.search;
    where.OR = [
      { email: { contains: term.toLowerCase() } },
      { username: { contains: term.toLowerCase() } },
      { displayName: { contains: term } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
  ]);

  const counts =
    rows.length > 0
      ? await prisma.server.groupBy({
          by: ['ownerId'],
          _count: { _all: true },
          where: { ownerId: { in: rows.map((row) => row.id) } },
        })
      : [];
  const countByOwner = new Map(counts.map((row) => [row.ownerId, row._count._all]));

  return {
    data: rows.map((row) => toUserDto(row, countByOwner.get(row.id) ?? 0)),
    meta: {
      page: query.page,
      perPage: query.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.perPage)),
    },
  };
}

export async function getUser(id: string): Promise<User> {
  const row = await prisma.user.findUnique({ where: { id } });
  if (!row) throw notFound('user');
  return toUserDto(row, await serverCountOf(id));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  email: string;
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
}

export async function createUser(input: CreateUserInput, actor: AuthenticatedUser): Promise<User> {
  // Rank protection at creation time too: an admin minting a fresh owner account is the
  // same escalation as promoting an existing one, just via a different door.
  if (input.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner can grant the owner role.');
  }

  const clash = await prisma.user.findFirst({
    where: { OR: [{ email: input.email }, { username: input.username }] },
    select: { email: true },
  });
  if (clash) throw alreadyExists(clash.email === input.email ? 'email' : 'username');

  const created = await prisma.user.create({
    data: {
      id: newId('usr'),
      email: input.email,
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      avatarColor: pickAvatarColor(input.username),
    },
  });

  return toUserDto(created, 0);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateUserInput {
  email?: string;
  username?: string;
  displayName?: string;
  password?: string;
  role?: UserRole;
  suspended?: boolean;
}

export interface UpdateUserOptions {
  logger?: FastifyBaseLogger;
}

/**
 * Every relative rule lives here, in one atomic transaction: rank protection, "an admin
 * cannot grant owner", and "the last owner may not be demoted or suspended". The owner
 * count is read and the row is written inside the same transaction so two concurrent
 * requests demoting the last two owners cannot both see "2" and both proceed — SQLite
 * serialises writers, so the second transaction re-reads after the first commits.
 */
export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actor: AuthenticatedUser,
  options: UpdateUserOptions = {},
): Promise<User> {
  // Hashed outside the transaction: argon2 is deliberately slow, and holding SQLite's
  // write lock for that long would serialise every other write behind it.
  const passwordHash =
    input.password !== undefined ? await hashPassword(input.password) : undefined;

  const { updated, wasSuspended } = await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id } });
    if (!target) throw notFound('user');
    assertCanAct(actor, target);

    if (input.role !== undefined && input.role === 'owner' && actor.role !== 'owner') {
      throw forbidden('Only an owner can grant the owner role.');
    }

    const nextRole = input.role ?? target.role;
    const nextSuspended = input.suspended ?? target.suspended;
    const wouldLoseOwner =
      target.role === 'owner' && (nextRole !== 'owner' || (nextSuspended && !target.suspended));
    if (wouldLoseOwner) {
      const ownerCount = await tx.user.count({ where: { role: 'owner' } });
      if (ownerCount <= 1) {
        throw conflict('Platter must always have at least one owner. Promote someone else first.');
      }
    }

    if (input.email !== undefined && input.email !== target.email) {
      if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
        throw alreadyExists('email');
      }
    }
    if (input.username !== undefined && input.username !== target.username) {
      if (await tx.user.findFirst({ where: { username: input.username }, select: { id: true } })) {
        throw alreadyExists('username');
      }
    }

    const data: Prisma.UserUpdateInput = {};
    if (input.email !== undefined) data.email = input.email;
    if (input.username !== undefined) data.username = input.username;
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.role !== undefined) data.role = input.role;
    if (input.suspended !== undefined) data.suspended = input.suspended;
    if (passwordHash !== undefined) data.passwordHash = passwordHash;

    const updatedRow = await tx.user.update({ where: { id }, data });
    return { updated: updatedRow, wasSuspended: target.suspended };
  });

  // Side effects outside the transaction: neither needs the same atomicity guarantee, and
  // both do meaningful I/O of their own (hashing already happened; this is driver calls
  // and further writes) that has no business holding the transaction open.
  if (passwordHash !== undefined) {
    await revokeSessionsAndApiKeys(updated.id);
  }
  if (input.suspended === true && !wasSuspended) {
    await suspendUserServers(updated.id, actor.id, options.logger);
  }

  return toUserDto(updated, await serverCountOf(updated.id));
}

/** Password changes revoke every session and every API key — see `changePasswordRequestSchema`
 * in `routes/auth.ts` for the self-service equivalent this mirrors. Sessions are revoked
 * (kept, marked dead) the same way `revokeAllRefreshTokens` does; API keys have no revoked
 * flag in the schema, so "revoked" means deleted, the same as `DELETE /auth/keys/:keyId`. */
async function revokeSessionsAndApiKeys(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.apiKey.deleteMany({ where: { userId } }),
  ]);
}

function bestStopAction(status: ServerStatus): PowerAction | null {
  if (canPerformPowerAction(status, 'stop')) return 'stop';
  if (canPerformPowerAction(status, 'kill')) return 'kill';
  return null;
}

/**
 * Suspending a user suspends their servers. This is one-directional on purpose: a server
 * can also be suspended on its own (see `AUDIT_ACTIONS['server.suspended']`), for a reason
 * unrelated to its owner's account, and there is no column recording *why* a server is
 * suspended. Un-suspending the user must not silently reactivate a server that was
 * suspended for its own reason, so it is left to whoever manages servers directly.
 *
 * The server's own `suspended` flag (not the user's) is what `assertAllowed` in
 * `lifecycle.ts` gates power actions on, so servers are stopped *before* that flag is set —
 * stopping an already-suspended server is rejected the same way stopping an already-offline
 * one is.
 */
async function suspendUserServers(
  userId: string,
  actorId: string | null,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const servers = await prisma.server.findMany({
    where: { ownerId: userId, suspended: false },
    select: { id: true, status: true },
  });

  await Promise.all(
    servers.map(async (server) => {
      const status = isServerStatus(server.status) ? server.status : 'offline';
      const action = bestStopAction(status);
      if (!action) return;
      try {
        await performPowerAction(server.id, action, actorId);
      } catch (error) {
        // Best-effort: the user is suspended either way. A container that could not be
        // stopped is a problem for whoever investigates next, not a reason to leave the
        // account active.
        logger?.warn(
          { err: error, serverId: server.id },
          'failed to stop a server while suspending its owner',
        );
      }
    }),
  );

  await prisma.server.updateMany({ where: { ownerId: userId }, data: { suspended: true } });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeleteUserOptions {
  /** Reassign the target's servers to this user instead of refusing the delete. */
  transferTo?: string | null;
}

export async function deleteUser(
  id: string,
  actor: AuthenticatedUser,
  options: DeleteUserOptions = {},
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id } });
    if (!target) throw notFound('user');
    assertCanAct(actor, target);

    if (target.role === 'owner') {
      const ownerCount = await tx.user.count({ where: { role: 'owner' } });
      if (ownerCount <= 1) {
        throw conflict('Platter must always have at least one owner. Promote someone else first.');
      }
    }

    const serverCount = await tx.server.count({ where: { ownerId: id } });
    if (serverCount > 0) {
      const transferTo = options.transferTo ?? null;
      if (!transferTo) {
        throw conflict(
          `${target.displayName} owns ${serverCount} ${serverCount === 1 ? 'server' : 'servers'}. ` +
            'Delete them first, or pass "transferTo" with another account’s id to reassign them.',
        );
      }
      if (transferTo === id) throw badRequest('Choose a different account to transfer servers to.');

      const newOwner = await tx.user.findUnique({ where: { id: transferTo } });
      if (!newOwner) throw notFound('user');
      if (newOwner.suspended)
        throw conflict('That account is suspended and cannot receive transferred servers.');

      await tx.server.updateMany({ where: { ownerId: id }, data: { ownerId: transferTo } });
    }

    // Sessions, API keys, subuser grants and conversations cascade at the database level
    // (see the `onDelete` directives in `schema.prisma`); servers are `Restrict`, which is
    // exactly the check just performed above.
    await tx.user.delete({ where: { id } });
  });
}
