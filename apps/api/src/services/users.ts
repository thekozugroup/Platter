import type { Prisma, User as UserRow } from '@prisma/client';
import {
  USER_ROLES,
  formatCount,
  type CreateUserRequest,
  type PaginationQuery,
  type Paginated,
  type UpdateUserRequest,
  type User,
  type UserRole,
} from '@platter/shared';
import { prisma } from '../db.js';
import { alreadyExists, badRequest, conflict, forbidden, invalidState, notFound, validationFailed } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import type { AuthenticatedUser } from '../plugins/auth.js';

/**
 * Admin user management: the CRUD surface behind `/users`, plus the invariants that keep
 * Platter administrable no matter what an admin does to the account list.
 *
 * Two rules recur everywhere below and are worth stating once: only an owner can create
 * another owner, and the last owner is untouchable (no demotion, no suspension, no
 * deletion). Both are enforced inside `prisma.$transaction` rather than with a plain
 * read-then-write — SQLite serialises writers at the file level, so a transaction here
 * really does see a consistent count even when two admin requests race.
 */

function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

function toUserDto(row: UserRow, serverCount: number): User {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.displayName,
    role: isUserRole(row.role) ? row.role : 'member',
    avatarColor: row.avatarColor,
    totpEnabled: row.totpEnabled,
    suspended: row.suspended,
    serverCount,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Only an owner may grant the owner role — to someone else, or to themselves. */
function assertCanAssignRole(actor: Pick<AuthenticatedUser, 'role'>, requestedRole: UserRole): void {
  if (requestedRole === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner can grant the owner role.');
  }
}

/** Must run inside the same transaction as the write it is guarding. */
async function assertNotLastOwner(tx: Prisma.TransactionClient, excludingUserId: string): Promise<void> {
  const remaining = await tx.user.count({ where: { role: 'owner', id: { not: excludingUserId } } });
  if (remaining === 0) {
    throw invalidState('Platter must always have at least one owner.');
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listUsers(query: PaginationQuery): Promise<Paginated<User>> {
  const [total, rows] = await Promise.all([
    prisma.user.count(),
    prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
      include: { _count: { select: { servers: true } } },
    }),
  ]);

  return {
    data: rows.map((row) => toUserDto(row, row._count.servers)),
    meta: {
      page: query.page,
      perPage: query.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.perPage)),
    },
  };
}

export async function getUserDto(userId: string): Promise<User> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    include: { _count: { select: { servers: true } } },
  });
  if (!row) throw notFound('user');
  return toUserDto(row, row._count.servers);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const AVATAR_COLORS = ['#5b8def', '#e0654f', '#3fa66a', '#c07ad6', '#d99b3a', '#3fa8b8'] as const;

function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

export async function createUser(
  input: CreateUserRequest,
  actor: Pick<AuthenticatedUser, 'role'>,
): Promise<User> {
  assertCanAssignRole(actor, input.role);

  const clash = await prisma.user.findFirst({
    where: { OR: [{ email: input.email }, { username: input.username }] },
    select: { email: true, username: true },
  });
  if (clash) throw alreadyExists(clash.email === input.email ? 'email' : 'username');

  const row = await prisma.user.create({
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

  return toUserDto(row, 0);
}

export interface UpdateUserResult {
  user: User;
  /** True when this call is the one that flipped `suspended` from false to true. */
  suspendedNow: boolean;
  /** True when this call changed the password, which the route uses to word the audit entry. */
  passwordChanged: boolean;
}

export async function updateUser(
  userId: string,
  input: UpdateUserRequest,
  actor: Pick<AuthenticatedUser, 'id' | 'role'>,
): Promise<UpdateUserResult> {
  // Hashed outside the transaction: argon2 is deliberately slow, and holding SQLite's
  // single writer lock for that long would stall every other write in the process.
  const passwordHash = input.password !== undefined ? await hashPassword(input.password) : undefined;

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { id: userId } });
    if (!existing) throw notFound('user');

    if (input.role !== undefined && input.role !== existing.role) {
      assertCanAssignRole(actor, input.role);
      if (existing.role === 'owner') await assertNotLastOwner(tx, userId);
    }
    const suspending = input.suspended === true && !existing.suspended;
    if (suspending && existing.role === 'owner') await assertNotLastOwner(tx, userId);

    if (input.email !== undefined && input.email !== existing.email) {
      const clash = await tx.user.findUnique({ where: { email: input.email }, select: { id: true } });
      if (clash) throw alreadyExists('email');
    }
    if (input.username !== undefined && input.username !== existing.username) {
      const clash = await tx.user.findUnique({ where: { username: input.username }, select: { id: true } });
      if (clash) throw alreadyExists('username');
    }

    const data: Prisma.UserUpdateInput = {};
    if (input.email !== undefined) data.email = input.email;
    if (input.username !== undefined) data.username = input.username;
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.role !== undefined) data.role = input.role;
    if (input.suspended !== undefined) data.suspended = input.suspended;
    if (passwordHash !== undefined) data.passwordHash = passwordHash;

    const updated = await tx.user.update({ where: { id: userId }, data });

    // Suspension cascades to what the account owns; un-suspending restores the same set.
    // A server an admin suspended independently, while the owner was still active, is
    // indistinguishable from one caught by this cascade — both simply read `suspended`.
    if (input.suspended !== undefined && input.suspended !== existing.suspended) {
      await tx.server.updateMany({ where: { ownerId: userId }, data: { suspended: input.suspended } });
    }

    if (passwordHash !== undefined) {
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      // Keys have no revoked flag to flip — an admin-forced password reset burns them
      // outright, the same as the user changing their own password does in `auth.ts`.
      await tx.apiKey.deleteMany({ where: { userId } });
    }

    const serverCount = await tx.server.count({ where: { ownerId: userId } });
    return { user: toUserDto(updated, serverCount), suspendedNow: suspending, passwordChanged: passwordHash !== undefined };
  });

  return result;
}

export async function deleteUser(
  userId: string,
  transferTo: string | undefined,
): Promise<{ email: string; displayName: string }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { id: userId } });
    if (!existing) throw notFound('user');
    if (existing.role === 'owner') await assertNotLastOwner(tx, userId);

    const ownedCount = await tx.server.count({ where: { ownerId: userId } });
    if (ownedCount > 0) {
      if (!transferTo) {
        throw conflict(
          `This account owns ${formatCount(ownedCount, 'server')}. Reassign them with \`transferTo\` before deleting it.`,
        );
      }
      if (transferTo === userId) {
        throw badRequest('Cannot transfer servers to the account being deleted.');
      }
      const newOwner = await tx.user.findUnique({ where: { id: transferTo }, select: { id: true, suspended: true } });
      if (!newOwner) throw validationFailed({ transferTo: ['That account does not exist.'] });
      if (newOwner.suspended) throw validationFailed({ transferTo: ['That account is suspended.'] });
      await tx.server.updateMany({ where: { ownerId: userId }, data: { ownerId: transferTo } });
    }

    // Sessions, API keys, subuser grants and conversations cascade via the schema;
    // backups keep their row with `createdById` set null (schema.prisma: SetNull).
    await tx.user.delete({ where: { id: userId } });
    return { email: existing.email, displayName: existing.displayName };
  });
}
