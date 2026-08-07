import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify, type Options } from '@node-rs/argon2';

/**
 * OWASP's 2024 argon2id baseline: 19 MiB of memory, two passes, one lane.
 *
 * Memory is the parameter that actually costs an attacker, so it is spent there rather
 * than on iterations. 19 MiB × the login concurrency we expect stays comfortably inside a
 * small container, and two passes keeps a verify near 50 ms — slow enough to matter for
 * offline cracking, fast enough that a login does not feel broken. Parallelism is 1
 * because a Node process gains nothing from lanes and the value is baked into the hash.
 */
const ARGON2_OPTIONS: Options = {
  // `Algorithm.Argon2id`. The binding declares Algorithm as an ambient const enum, which
  // cannot be imported under `isolatedModules`, so the member value is inlined here
  // exactly as the compiler would have inlined it.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Returns false instead of throwing on a malformed stored hash. A corrupt row is an
 * authentication failure, not a 500 that tells an attacker they found something unusual.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Burns one argon2 verify when no user matched.
 *
 * Without it, "unknown email" returns in microseconds while "wrong password" takes ~50 ms,
 * which turns the login endpoint into an account-enumeration oracle. The reference hash is
 * computed once, lazily, over a random password nobody can supply.
 */
export async function dummyVerify(): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  await verifyPassword(await dummyHash, 'platter-dummy-verification-input');
}

// ---------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------

/**
 * Refresh tokens and API keys are 256 bits of CSPRNG output, so they need no key
 * stretching — SHA-256 is enough to make the stored value useless, and it is fast enough
 * to run on every authenticated request.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 32 bytes, base64url — URL- and cookie-safe with no escaping. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Compares two hex digests without leaking how far the match got. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a signal; hashes of
  // the same algorithm are always the same length, so an early false is safe here.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
