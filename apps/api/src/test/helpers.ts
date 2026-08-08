import type { FastifyInstance } from 'fastify';
import type { UserRole } from '@platter/shared';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { newId } from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import { resetLogHubs } from '../orchestration/log-buffer.js';
import { resetDrivers } from '../orchestration/registry.js';
import type { AuthenticatedUser } from '../plugins/auth.js';

/**
 * The integration harness: a real Fastify instance, a real SQLite database and the mock
 * orchestration driver.
 *
 * Nothing here stubs a service. A test that mocked `services/lifecycle.ts` would prove the
 * route calls a function, which is not the interesting claim — the interesting claim is
 * that a POST to `/servers/:id/power` moves a container and comes back with the new
 * status. `src/test/setup.ts` has already pointed the environment at a throwaway database
 * and forced `DEFAULT_NODE_DRIVER=mock` before this module is loaded.
 */

export interface TestUser extends AuthenticatedUser {
  /** The plaintext password, so a test can drive the real login endpoint. */
  password: string;
  accessToken: string;
}

/**
 * Order matters: children before parents, because SQLite enforces the foreign keys Prisma
 * declared and `deleteMany` does not cascade for us.
 */
const TRUNCATION_ORDER = [
  'auditLog',
  'message',
  'conversation',
  'schedule',
  'backup',
  'serverSubuser',
  'allocation',
  'server',
  'apiKey',
  'session',
  'user',
  'setting',
  'node',
] as const;

/**
 * Builds an app wired exactly like production, minus the background loops.
 *
 * `startBackgroundServices` is deliberately not called: a test that injected a request
 * while the crash supervisor and scheduler were ticking would be racing them, and every
 * one of those loops is tested directly elsewhere.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false });
  await app.ready();
  return app;
}

/** The node every test server is created on. Idempotent, so each test may just call it. */
export async function ensureTestNode(): Promise<string> {
  const id = 'nod_test';
  await prisma.node.upsert({
    where: { id },
    update: {},
    create: {
      id,
      name: 'test',
      driver: 'mock',
      endpoint: 'mock://local',
      publicHost: '127.0.0.1',
      portRangeStart: config.portRangeStart,
      portRangeEnd: config.portRangeEnd,
      // Generous enough that no capacity check in `selectNode` is the reason a test fails.
      memoryTotalMb: 65_536,
      diskTotalMb: 1_048_576,
      cpuCores: 8,
    },
  });
  return id;
}

let userCounter = 0;

/**
 * Creates a user with a real argon2 password hash and a signed access token.
 *
 * The hash is real rather than a placeholder because `POST /auth/login` verifies it, and a
 * harness whose users cannot log in would quietly push every test onto the token path.
 */
export async function createTestUser(
  role: UserRole = 'owner',
  overrides: { email?: string; password?: string; suspended?: boolean } = {},
): Promise<TestUser> {
  userCounter += 1;
  const password = overrides.password ?? `Test-password-${userCounter}!`;
  const email = overrides.email ?? `user${userCounter}@example.test`;

  const row = await prisma.user.create({
    data: {
      id: newId('usr'),
      email,
      username: `user${userCounter}`,
      displayName: `Test User ${userCounter}`,
      passwordHash: await hashPassword(password),
      role,
      avatarColor: '#4f46e5',
      suspended: overrides.suspended ?? false,
    },
  });

  const user: AuthenticatedUser = {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.displayName,
    role,
    avatarColor: row.avatarColor,
    totpEnabled: row.totpEnabled,
    suspended: row.suspended,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };

  // Signed with the same app instance's key. Built lazily so a test that only needs a row
  // does not pay for an app.
  const app = await tokenSigner();
  return { ...user, password, accessToken: app.issueAccessToken(user) };
}

let signer: FastifyInstance | null = null;

async function tokenSigner(): Promise<FastifyInstance> {
  signer ??= await buildApp({ logger: false });
  await signer.ready();
  return signer;
}

export function authHeaders(user: Pick<TestUser, 'accessToken'>): Record<string, string> {
  return { authorization: `Bearer ${user.accessToken}` };
}

/** API-key form, for the surfaces that refuse a JWT (MCP over HTTP). */
export function apiKeyHeaders(token: string): Record<string, string> {
  return { 'x-api-key': token };
}

/**
 * Empties every table between tests.
 *
 * Deletes rather than dropping and recreating: `prisma db push` costs seconds and the
 * connection would have to be re-established, whereas eleven `DELETE`s against an empty
 * SQLite database are microseconds. In-process caches that key on a server id are reset
 * alongside, or a later test would inherit the previous one's log hub.
 */
export async function resetDatabase(): Promise<void> {
  for (const table of TRUNCATION_ORDER) {
    // Indexed access on the client is what lets this be a data-driven list rather than
    // eleven near-identical statements that drift when a model is added.
    await (prisma[table] as { deleteMany: () => Promise<unknown> }).deleteMany();
  }
  resetLogHubs();
  resetDrivers();
}

/** Closes anything `createTestUser` opened. Call from a suite's `afterAll`. */
export async function closeTestHarness(): Promise<void> {
  if (signer) {
    await signer.close();
    signer = null;
  }
  await prisma.$disconnect();
}
