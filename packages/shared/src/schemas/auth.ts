import { z } from 'zod';
import { LIMITS, USER_ROLES } from '../domain.js';
import { idSchema, isoDateSchema } from './common.js';

/**
 * Password policy: length over composition rules. A 12-character passphrase beats
 * `P@ssw0rd!`, and composition rules mostly teach people to write predictable
 * substitutions, so we check length and a blocklist of obvious choices instead.
 */
export const passwordSchema = z
  .string()
  .min(LIMITS.passwordMin, `Use at least ${LIMITS.passwordMin} characters`)
  .max(LIMITS.passwordMax)
  .refine((value) => !WEAK_PASSWORDS.has(value.toLowerCase()), 'That password is too common');

const WEAK_PASSWORDS = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiop12',
  'administrator',
  'letmeinplease',
  'platterplatter',
]);

export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Lowercase letters, numbers, dashes and underscores only');

export const emailSchema = z.string().email().max(320).toLowerCase().trim();

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password'),
  /** Six-digit TOTP, required only once the account has 2FA enabled. */
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  rememberMe: z.boolean().default(false),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const registerRequestSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  displayName: z.string().min(1).max(64).trim(),
  password: passwordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const sessionUserSchema = z.object({
  id: idSchema,
  email: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(USER_ROLES),
  avatarColor: z.string(),
  totpEnabled: z.boolean(),
  createdAt: isoDateSchema,
  lastLoginAt: isoDateSchema.nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const authResponseSchema = z.object({
  user: sessionUserSchema,
  accessToken: z.string(),
  /** Seconds until `accessToken` expires; the client refreshes a minute early. */
  expiresIn: z.number().int(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

/** Tells the login screen whether to offer "create the first account". */
export const bootstrapStatusSchema = z.object({
  needsSetup: z.boolean(),
  registrationEnabled: z.boolean(),
  version: z.string(),
});
export type BootstrapStatus = z.infer<typeof bootstrapStatusSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const totpSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  recoveryCodes: z.array(z.string()),
});

export const totpConfirmRequestSchema = z.object({
  token: z.string().regex(/^\d{6}$/),
});

export const apiKeySchema = z.object({
  id: idSchema,
  name: z.string(),
  prefix: z.string(),
  lastUsedAt: isoDateSchema.nullable(),
  expiresAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const createApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(64),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});

/** The plaintext token is returned exactly once, at creation. */
export const createApiKeyResponseSchema = apiKeySchema.extend({ token: z.string() });
