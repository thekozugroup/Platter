import { randomInt } from 'node:crypto';
import { passwordSchema, type UserRole } from '@platter/shared';
import { config } from '../src/config.js';
import { connectDatabase, disconnectDatabase, prisma } from '../src/db.js';
import { newId } from '../src/lib/ids.js';
import { hashPassword } from '../src/lib/password.js';
import { ensureDefaultNode } from '../src/services/nodes.js';

/**
 * Brings an empty database up to the minimum Platter needs to be usable: one node to put
 * servers on, and one account to log in with.
 *
 * Idempotent by design — `pnpm db:seed` is part of the deploy path, not a one-off, so it
 * has to be safe to run against a database that already has real data in it. Nothing here
 * ever overwrites an existing row: if an owner already exists, the account step is skipped
 * entirely rather than resetting somebody's password on a redeploy.
 *
 * The password rule is the part worth being careful about. A hardcoded default credential
 * in a self-hosted control panel is a back door — Platter is exposed to a LAN at minimum
 * and often to the internet — so when `SEED_PASSWORD` is unset a strong one is generated
 * and printed once. It is never written to a file and never logged again.
 */

/** Unambiguous alphabet: no O/0, l/1/I. The password gets read off a terminal and typed. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const GENERATED_PASSWORD_LENGTH = 24;

function generatePassword(): string {
  let out = '';
  // `randomInt` rather than `Math.random`: this is a credential.
  for (let i = 0; i < GENERATED_PASSWORD_LENGTH; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

function usernameFrom(email: string): string {
  const local = email.split('@')[0] ?? 'owner';
  const cleaned = local.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return cleaned.length >= 3 ? cleaned.slice(0, 32) : 'owner';
}

/** Deterministic from the email, so an account keeps its colour across environments. */
function avatarColour(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 65% 55%)`;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function seedNode(): Promise<void> {
  const before = await prisma.node.count();
  const node = await ensureDefaultNode();
  log(
    before === 0
      ? `  node      created "${node.name}" (${node.driver} at ${node.endpoint})`
      : `  node      ${before} already present, leaving alone`,
  );
}

async function seedOwner(): Promise<void> {
  const envEmail = process.env['SEED_EMAIL']?.trim();
  const envPassword = process.env['SEED_PASSWORD'];

  // "Is there anybody who can administer this install?" — not "does this exact email
  // exist". Re-seeding with a different SEED_EMAIL must not mint a second owner.
  const existingOwner = await prisma.user.findFirst({
    where: { role: { in: ['owner'] satisfies UserRole[] } },
    select: { email: true },
  });
  if (existingOwner) {
    log(`  owner     ${existingOwner.email} already exists, leaving alone`);
    return;
  }

  const email = envEmail && envEmail.length > 0 ? envEmail : 'owner@platter.local';

  // A conflicting non-owner row would fail the unique constraint below with a Prisma
  // error nobody can act on; say what to do instead.
  const clash = await prisma.user.findUnique({ where: { email }, select: { role: true } });
  if (clash) {
    log(`  owner     ${email} exists as "${clash.role}"; promote it manually rather than seeding`);
    return;
  }

  let password: string;
  let generated = false;
  if (envPassword !== undefined && envPassword.length > 0) {
    const checked = passwordSchema.safeParse(envPassword);
    if (!checked.success) {
      // Validated against the same rule the API enforces, so a seeded account can never be
      // weaker than one created through the UI.
      const reason = checked.error.issues.map((issue) => issue.message).join('; ');
      throw new Error(`SEED_PASSWORD is not acceptable: ${reason}`);
    }
    password = envPassword;
  } else {
    password = generatePassword();
    generated = true;
  }

  await prisma.user.create({
    data: {
      id: newId('usr'),
      email,
      username: usernameFrom(email),
      displayName: 'Owner',
      passwordHash: await hashPassword(password),
      role: 'owner',
      avatarColor: avatarColour(email),
    },
  });

  log(`  owner     created ${email}`);
  if (generated) {
    // The only time this string is ever printed. It is not stored anywhere in plaintext.
    log('');
    log('  ┌─────────────────────────────────────────────────────────────┐');
    log('  │  Sign in with this password. It will not be shown again.    │');
    log('  └─────────────────────────────────────────────────────────────┘');
    log(`      email:    ${email}`);
    log(`      password: ${password}`);
    log('');
    log('  Set SEED_EMAIL and SEED_PASSWORD to choose these yourself.');
  }
}

async function main(): Promise<void> {
  log(`Seeding Platter (${config.nodeEnv})`);
  await connectDatabase();
  await seedNode();
  await seedOwner();
  log('Done.');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
