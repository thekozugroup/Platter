import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Context,
  createBackup,
  listBackups,
  resolveServer,
  restoreBackup,
} from '@platter/core';
import { isErr } from '@platter/shared';
import { z } from 'zod';
import { proposeAndConfirm, recordOutcome } from '../confirm';
import { formatAgo, formatBytes, result, toolError } from '../format';

export function registerBackupTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'list_backups',
    {
      title: 'List backups',
      description:
        "A server's backups, newest first, with size and whether each was taken live or while " +
        'stopped. Use this before proposing anything risky — knowing a recent backup exists is ' +
        'what makes a change safe to suggest.',
      inputSchema: { server: z.string().describe('Server id, slug or name') },
      outputSchema: {
        backups: z.array(
          z.object({
            id: z.string(),
            label: z.string().nullable(),
            status: z.string(),
            sizeBytes: z.number().nullable(),
            hot: z.boolean(),
            trigger: z.string(),
            createdAt: z.number(),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ server: reference }) => {
      const found = resolveServer(ctx.db, reference);
      if (!found) {
        return toolError(`No server matching "${reference}".`);
      }

      const backups = listBackups(ctx, found.id);
      const text =
        backups.length === 0
          ? 'No backups yet.'
          : backups
              .map(
                (b) =>
                  `${b.id} · ${formatAgo(b.createdAt)} · ` +
                  `${b.sizeBytes === null ? 'unknown size' : formatBytes(b.sizeBytes)} · ` +
                  `${b.hotBackup ? 'taken live' : 'taken while stopped'} · ${b.status}` +
                  (b.label ? ` · ${b.label}` : '')
              )
              .join('\n');

      return result(text, {
        backups: backups.map((b) => ({
          id: b.id,
          label: b.label,
          status: b.status,
          sizeBytes: b.sizeBytes,
          hot: b.hotBackup,
          trigger: b.trigger,
          createdAt: b.createdAt,
        })),
      });
    }
  );

  server.registerTool(
    'create_backup',
    {
      title: 'Back up a server',
      description:
        'Take a backup. If the server is running this is a live snapshot — Platter pauses ' +
        'auto-save, flushes loaded chunks to disk, archives, then resumes, so nobody is ' +
        'disconnected and no chunk is caught half-written. Safe to call before any risky change.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        label: z
          .string()
          .max(120)
          .optional()
          .describe('A note about why, e.g. "before adding Create"'),
      },
      outputSchema: {
        backupId: z.string(),
        sizeBytes: z.number(),
        hot: z.boolean(),
      },
      // Creating a backup only writes a new archive; it never modifies the world. Marking it
      // non-destructive lets hosts run it without a prompt, which is what you want when an
      // agent is about to do something risky and wants a safety net first.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ server: reference, label }) => {
      const found = resolveServer(ctx.db, reference);
      if (!found) {
        return toolError(`No server matching "${reference}".`);
      }

      const created = await createBackup(ctx, {
        serverId: found.id,
        ...(label ? { label } : {}),
        trigger: 'manual',
        actor: 'ai',
      });

      if (isErr(created)) {
        return toolError(created.error.message);
      }

      return result(
        `Backed up ${found.name} (${formatBytes(created.value.sizeBytes)})` +
          `${found.status === 'running' ? ' while it was running — nobody was disconnected' : ''}.`,
        {
          backupId: created.value.id,
          sizeBytes: created.value.sizeBytes,
          hot: found.status === 'running',
        }
      );
    }
  );

  server.registerTool(
    'restore_backup',
    {
      title: 'Restore a backup',
      description:
        'Roll a server back to a backup. The server stops, its data is replaced, and it starts ' +
        'again. Everything built since the backup is lost, so this always asks first. Platter ' +
        'takes a safety copy of the current state before overwriting anything.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        backupId: z.string().describe('Backup id from list_backups'),
        reason: z.string().optional().describe('Why — shown to the human deciding'),
      },
      outputSchema: {
        restored: z.boolean(),
        reason: z
          .enum(['declined', 'cancelled', 'unsupported'])
          .optional()
          .describe('Present when a confirmation was declined instead of restored'),
        backupId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ server: reference, backupId, reason }) => {
      const found = resolveServer(ctx.db, reference);
      if (!found) {
        return toolError(`No server matching "${reference}".`);
      }

      const backup = listBackups(ctx, found.id).find((b) => b.id === backupId);
      if (!backup) {
        return toolError(
          `No backup ${backupId} for ${found.name}.`,
          'Call list_backups to see the available ids.'
        );
      }
      if (backup.status !== 'complete') {
        return toolError(`Backup ${backupId} is ${backup.status} and cannot be restored.`);
      }

      const age = formatAgo(backup.createdAt);
      const decision = await proposeAndConfirm({
        ctx,
        server,
        serverId: found.id,
        kind: 'restore_backup',
        title: `Restore ${found.name} to a backup from ${age}`,
        rationale: reason,
        payload: { backupId, backupCreatedAt: backup.createdAt },
        impact: { destroysRecentProgress: true, restartsServer: true },
        question: `Roll ${found.name} back to the backup from ${age}?`,
        details: [
          `Everything built or changed in the last ${age.replace(' ago', '')} will be lost.`,
          'The server will stop and restart.',
          'A safety copy of the current state is taken first, so this can be undone.',
        ],
      });

      if (!decision.approved) {
        return result(decision.message, { restored: false, reason: decision.reason });
      }

      const restored = await restoreBackup(ctx, backupId, { actor: 'ai' });
      recordOutcome(ctx, decision.proposalId, {
        ok: !isErr(restored),
        serverId: found.id,
        ...(isErr(restored) ? { message: restored.error.message } : {}),
      });

      if (isErr(restored)) {
        return toolError(restored.error.message);
      }
      return result(`Restored ${found.name} to the backup from ${age}. It is starting again.`, {
        restored: true,
        backupId,
      });
    }
  );
}
