import { z } from 'zod';
import { BACKUP_STATUSES, SCHEDULE_ACTIONS } from '../domain.js';
import { idSchema, isoDateSchema } from './common.js';

export const backupSchema = z.object({
  id: idSchema,
  serverId: idSchema,
  name: z.string(),
  status: z.enum(BACKUP_STATUSES),
  sizeBytes: z.number().int().nullable(),
  /** SHA-256 of the archive, verified before any restore. */
  checksum: z.string().nullable(),
  /** True for backups created by a schedule rather than by hand. */
  automatic: z.boolean(),
  /** Locked backups are exempt from rotation and cannot be deleted until unlocked. */
  locked: z.boolean(),
  error: z.string().nullable(),
  createdById: idSchema.nullable(),
  createdAt: isoDateSchema,
  completedAt: isoDateSchema.nullable(),
});
export type Backup = z.infer<typeof backupSchema>;

export const createBackupRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  /** Glob patterns excluded from the archive, on top of the blueprint's defaults. */
  ignore: z.array(z.string().max(200)).max(50).default([]),
  locked: z.boolean().default(false),
});
export type CreateBackupRequest = z.infer<typeof createBackupRequestSchema>;

export const restoreBackupRequestSchema = z.object({
  /** Wipe the data volume first. Off by default: merging is the safer surprise. */
  truncate: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** Five-field cron, minute precision. Validated properly server-side by the cron parser. */
export const cronExpressionSchema = z
  .string()
  .min(9)
  .max(120)
  .regex(/^[\d*/,\-\s?LW#]+$/, 'That does not look like a cron expression');

export const scheduleSchema = z.object({
  id: idSchema,
  serverId: idSchema,
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  action: z.enum(SCHEDULE_ACTIONS),
  /** Console command for the `command` action. */
  payload: z.string().nullable(),
  enabled: z.boolean(),
  /** Skip this run if the server is offline, instead of waking it. */
  onlyWhenOnline: z.boolean(),
  lastRunAt: isoDateSchema.nullable(),
  lastRunStatus: z.enum(['success', 'failed', 'skipped']).nullable(),
  lastRunError: z.string().nullable(),
  nextRunAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const createScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(64),
    cron: cronExpressionSchema,
    timezone: z.string().min(1).max(64).default('UTC'),
    action: z.enum(SCHEDULE_ACTIONS),
    payload: z.string().max(500).nullable().default(null),
    enabled: z.boolean().default(true),
    onlyWhenOnline: z.boolean().default(true),
  })
  .superRefine((schedule, ctx) => {
    if (schedule.action === 'command' && !schedule.payload?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter the command to run',
        path: ['payload'],
      });
    }
  });
export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>;

export const updateScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    cron: cronExpressionSchema.optional(),
    timezone: z.string().min(1).max(64).optional(),
    action: z.enum(SCHEDULE_ACTIONS).optional(),
    payload: z.string().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
    onlyWhenOnline: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');
