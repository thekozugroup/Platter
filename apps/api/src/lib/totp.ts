import { randomInt } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { sha256Hex } from './password.js';

/**
 * Standard authenticator settings. These are not configurable: every widely used app
 * (Google Authenticator, 1Password, Aegis) assumes SHA-1 / 6 digits / 30 seconds, and a
 * blueprint of a login screen is not the place to be interesting.
 */
const TOTP_CONFIG = { algorithm: 'SHA1', digits: 6, period: 30 } as const;

const ISSUER = 'Platter';

/** One step either side of now — covers clock skew without meaningfully widening the window. */
const VERIFY_WINDOW = 1;

/** 160 bits, the size RFC 4226 recommends for HMAC-SHA1 keys. */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function buildOtpauthUrl(secret: string, accountLabel: string): string {
  return new TOTP({
    ...TOTP_CONFIG,
    issuer: ISSUER,
    label: accountLabel,
    secret: Secret.fromBase32(secret),
  }).toString();
}

/**
 * Returns false rather than throwing on a malformed secret or token: this runs on the
 * login path, where every failure mode is "the code is wrong".
 */
export function verifyTotp(secret: string, token: string): boolean {
  try {
    const totp = new TOTP({ ...TOTP_CONFIG, secret: Secret.fromBase32(secret) });
    return totp.validate({ token, window: VERIFY_WINDOW }) !== null;
  } catch {
    return false;
  }
}

/**
 * Crockford-style alphabet minus the characters people misread when copying a code off a
 * printout: no I, L, O, U, and no digits 0 or 1.
 */
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_GROUP_LENGTH = 5;

/** `A3K9P-Q7XM2` — 10 characters from a 30-symbol alphabet, ~49 bits each. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let code = '';
    for (let position = 0; position < RECOVERY_GROUP_LENGTH * 2; position += 1) {
      if (position === RECOVERY_GROUP_LENGTH) code += '-';
      code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(code);
  }
  return codes;
}

/** Case and separators are cosmetic; compare and hash the canonical form only. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Recovery codes are high-entropy single-use secrets, so a plain digest is the right
 * primitive here — argon2 would buy nothing and would make redemption noticeably slow.
 */
export function hashRecoveryCode(code: string): string {
  return sha256Hex(normalizeRecoveryCode(code));
}
