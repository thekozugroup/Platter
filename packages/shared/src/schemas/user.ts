import { z } from 'zod';
import { USER_ROLES } from '../domain.js';
import { emailSchema, passwordSchema, usernameSchema } from './auth.js';
import { idSchema, isoDateSchema } from './common.js';

export const userSchema = z.object({
  id: idSchema,
  email: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(USER_ROLES),
  avatarColor: z.string(),
  totpEnabled: z.boolean(),
  suspended: z.boolean(),
  serverCount: z.number().int(),
  lastLoginAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
});
export type User = z.infer<typeof userSchema>;

export const createUserRequestSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  displayName: z.string().min(1).max(64).trim(),
  password: passwordSchema,
  role: z.enum(USER_ROLES).default('member'),
});

export const updateUserRequestSchema = z
  .object({
    email: emailSchema.optional(),
    username: usernameSchema.optional(),
    displayName: z.string().min(1).max(64).trim().optional(),
    password: passwordSchema.optional(),
    role: z.enum(USER_ROLES).optional(),
    suspended: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

export const updateProfileRequestSchema = z
  .object({
    displayName: z.string().min(1).max(64).trim().optional(),
    email: emailSchema.optional(),
    avatarColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');
