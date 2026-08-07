import { randomBytes } from 'node:crypto';

/**
 * Crockford base32, minus I, L, O and U so an id read over voice chat survives the trip.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let mod: number;
  let time = now;
  let out = '';
  for (let i = TIME_LEN; i > 0; i--) {
    mod = time % ENCODING_LEN;
    out = ENCODING[mod] + out;
    time = (time - mod) / ENCODING_LEN;
  }
  return out;
}

function randomChars(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const out: number[] = [];
  for (let i = 0; i < RANDOM_LEN; i++) {
    // biome-ignore lint/style/noNonNullAssertion: randomBytes(RANDOM_LEN) always has RANDOM_LEN entries
    out.push(bytes[i]! % ENCODING_LEN);
  }
  return out;
}

/**
 * Increment the random component in place so that two ULIDs minted in the same millisecond
 * still sort in creation order. Without this, the activity feed shuffles events that happened
 * in a single tick, which looks like a bug every time someone notices it.
 */
function incrementRandom(chars: number[]): number[] {
  const next = [...chars];
  for (let i = next.length - 1; i >= 0; i--) {
    // biome-ignore lint/style/noNonNullAssertion: index is bounded by next.length
    if (next[i]! < ENCODING_LEN - 1) {
      // biome-ignore lint/style/noNonNullAssertion: index is bounded by next.length
      next[i] = next[i]! + 1;
      return next;
    }
    next[i] = 0;
  }
  // Overflowed all 16 characters in one millisecond. Practically impossible; start fresh.
  return randomChars();
}

/** Monotonic ULID. Lexicographic sort === chronological sort. */
export function ulid(seedTime: number = Date.now()): string {
  if (seedTime === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = seedTime;
    lastRandom = randomChars();
  }
  return encodeTime(seedTime) + lastRandom.map((c) => ENCODING[c]).join('');
}

export const isUlid = (value: string): boolean => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);

/** Extract the millisecond timestamp a ULID was minted at. */
export function ulidTime(id: string): number {
  let time = 0;
  for (const char of id.slice(0, TIME_LEN)) {
    const index = ENCODING.indexOf(char);
    if (index === -1) {
      throw new Error(`invalid ULID character: ${char}`);
    }
    time = time * ENCODING_LEN + index;
  }
  return time;
}

/**
 * Turn a display name into a slug safe for container names, volume names and directory names.
 * Falls back to a deterministic-ish stub when the name is entirely non-ASCII, because
 * "サーバー" must still produce a valid container name.
 */
export function slugify(name: string, fallback = 'server'): string {
  const slug = name
    .normalize('NFKD')
    // Strip combining diacritics so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : fallback;
}

/** URL-safe random token for API keys and MCP bearer tokens. */
export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * RCON password. Kept alphanumeric on purpose: the RCON packet format is length-prefixed and
 * null-terminated, and a handful of server implementations mangle non-ASCII payloads. There is
 * no upside to exotic characters when the value is 32 chars of CSPRNG output.
 */
export function rconPassword(length = 32): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by bytes.length
    const byte = bytes[i]!;
    // Reject values in the truncated tail so every character is uniformly distributed.
    if (byte < 256 - (256 % alphabet.length)) {
      out += alphabet[byte % alphabet.length];
    }
  }
  return out.length === length ? out : out.padEnd(length, 'x');
}
