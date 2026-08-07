import { z } from 'zod';
import { idSchema, isoDateSchema } from './common.js';

/**
 * Every state-changing action writes one of these. The list is closed so the UI can
 * render a human sentence per action instead of dumping raw verbs at the operator.
 */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_changed',
  'auth.totp_enabled',
  'auth.totp_disabled',
  'apikey.created',
  'apikey.revoked',
  'user.created',
  'user.updated',
  'user.deleted',
  'user.suspended',
  'server.created',
  'server.updated',
  'server.deleted',
  'server.reinstalled',
  'server.suspended',
  'server.power',
  'server.command',
  'server.subuser_added',
  'server.subuser_updated',
  'server.subuser_removed',
  'file.written',
  'file.deleted',
  'file.renamed',
  'file.uploaded',
  'backup.created',
  'backup.restored',
  'backup.deleted',
  'schedule.created',
  'schedule.updated',
  'schedule.deleted',
  'schedule.executed',
  'node.created',
  'node.updated',
  'node.deleted',
  'ai.provision_proposed',
  'ai.fix_applied',
  'settings.updated',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditEntrySchema = z.object({
  id: idSchema,
  action: z.enum(AUDIT_ACTIONS),
  /** Null for system-initiated actions such as a schedule firing. */
  actorId: idSchema.nullable(),
  actorName: z.string().nullable(),
  targetType: z.enum(['server', 'user', 'node', 'backup', 'schedule', 'apikey', 'system']),
  targetId: z.string().nullable(),
  targetName: z.string().nullable(),
  /** Action-specific context: the power action, the file path, the fields changed. */
  metadata: z.record(z.string(), z.unknown()).default({}),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: isoDateSchema,
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const listAuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
  action: z.enum(AUDIT_ACTIONS).optional(),
  actorId: idSchema.optional(),
  targetId: z.string().optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
});
