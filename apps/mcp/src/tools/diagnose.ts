import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import {
  type Context,
  EVENT,
  emitEvent,
  describeServer,
  readLogTail,
  recreateContainer,
  resolveServer,
  restartServer,
  removeMods,
  restoreBackup,
  updateServer,
  updateSettings,
} from '@platter/core';
import { diagnoses, modInstalls } from '@platter/db';
import { type FixAction, diagnose, explainPlan, planFixes } from '@platter/diagnostics';
import { isErr, ulid } from '@platter/shared';
import { z } from 'zod';
import { proposeAndConfirm, recordOutcome } from '../confirm';
import { result, toolError } from '../format';

/**
 * Diagnosis and repair.
 *
 * The loop this is built for:
 *
 *   diagnose_server   read the logs, match the rule catalogue, explain what is wrong
 *   apply_fix         propose the specific change, get a human's yes, apply it, restart
 *   diagnose_server   confirm it is actually fixed, or find the next problem
 *
 * `diagnose_server` is deliberately read-only and cheap, so an agent can call it freely — after
 * a crash, after an install, after a restart. The fixes it returns are declarative data, not
 * callbacks, precisely so they can cross this boundary and be shown to a person before anything
 * happens.
 */
export function registerDiagnosticTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'diagnose_server',
    {
      title: 'Diagnose a server',
      description:
        "Read a server's recent logs and explain what is wrong in plain terms, with concrete " +
        'fixes. Understands Java version mismatches, out-of-memory kills, missing mod ' +
        'dependencies, mixin failures, client-only mods on a server, port conflicts, corrupt ' +
        'chunks and watchdog hangs. Call this after any crash or failed start before guessing.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        lines: z.number().int().min(50).max(5000).default(600).describe('How much log to analyse'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ server: reference, lines }) => {
      const target = resolveServer(ctx.db, reference);
      if (!target) {
        return toolError(`No server matching "${reference}".`);
      }

      const described = await describeServer(ctx, target.id);
      if (isErr(described)) {
        return toolError(described.error.message);
      }

      const logLines = target.containerId
        ? await readLogTail(ctx.docker, target.containerId, lines)
        : undefined;

      if (logLines && isErr(logLines)) {
        return toolError(logLines.error.message);
      }

      const installed = ctx.db
        .select()
        .from(modInstalls)
        .where(and(eq(modInstalls.serverId, target.id), eq(modInstalls.status, 'installed')))
        .all()
        .map((row) => ({
          name: row.displayName,
          slug: row.projectSlug ?? undefined,
          fileName: row.filePath?.split('/').at(-1) ?? undefined,
          version: row.versionLabel ?? undefined,
        }));

      const diagnosis = diagnose({
        lines: (logLines?.ok ? logLines.value : []).map((line) => ({
          text: line.text,
          seq: line.seq,
          stream: line.stream,
          timestamp: line.timestamp ?? null,
        })),
        server: {
          loader: target.loader,
          gameVersion: target.gameVersion,
          memoryMiB: target.memoryMiB,
          status: target.status,
          exitCode: described.value.exitCode ?? null,
          health: described.value.health ?? 'none',
        },
        installed,
      });

      // Recorded so the UI can show it and a later fix can point back at what motivated it.
      const diagnosisId = ulid();
      ctx.db
        .insert(diagnoses)
        .values({
          id: diagnosisId,
          serverId: target.id,
          trigger: 'mcp',
          findings: diagnosis.findings,
          summary: diagnosis.summary,
        })
        .run();

      emitEvent(ctx.db, {
        serverId: target.id,
        type: EVENT.diagnosisCreated,
        level: diagnosis.healthy ? 'info' : 'warn',
        message: diagnosis.summary,
        actor: 'ai',
        data: { diagnosisId, findingCount: diagnosis.findings.length },
      });

      const plan = planFixes(diagnosis);
      const text = [
        diagnosis.summary,
        '',
        ...diagnosis.findings.flatMap((finding) => [
          `${severityMark(finding.severity)} ${finding.title}`,
          `   ${finding.explanation}`,
          ...finding.fixes.map(
            (fix) =>
              `   → ${fix.title}${fix.kind === 'automatic' ? ' (Platter can do this)' : ' (manual)'}` +
              `\n     ${fix.detail}`
          ),
          '',
        ]),
        ...(plan.steps.length > 0 ? ['Suggested order:', explainPlan(plan)] : []),
      ].join('\n');

      return result(text, {
        diagnosisId,
        summary: diagnosis.summary,
        healthy: diagnosis.healthy,
        analysedLines: diagnosis.analysedLines,
        findings: diagnosis.findings,
        plan,
      });
    }
  );

  server.registerTool(
    'apply_fix',
    {
      title: 'Apply a fix from a diagnosis',
      description:
        'Carry out one of the automatic fixes diagnose_server suggested — change the memory ' +
        'limit, remove a mod, change a setting, roll back to a backup. Always asks for ' +
        'confirmation and explains exactly what will change. Restarts the server when the fix ' +
        'needs it.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        diagnosisId: z.string().describe('The diagnosis this fix came from'),
        fixId: z.string().describe('Fix id from the diagnosis'),
        reason: z.string().optional().describe('Why — shown to the human deciding'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ server: reference, diagnosisId, fixId, reason }) => {
      const target = resolveServer(ctx.db, reference);
      if (!target) {
        return toolError(`No server matching "${reference}".`);
      }

      const row = ctx.db.select().from(diagnoses).where(eq(diagnoses.id, diagnosisId)).get();
      if (!row || row.serverId !== target.id) {
        return toolError(
          `No diagnosis ${diagnosisId} for ${target.name}.`,
          'Run diagnose_server first — fixes are only valid for the diagnosis that produced them.'
        );
      }

      const findings = row.findings as {
        ruleId: string;
        title: string;
        fixes: { id: string; title: string; detail: string; kind: string; action?: FixAction }[];
      }[];

      const fix = findings.flatMap((f) => f.fixes).find((f) => f.id === fixId);
      if (!fix) {
        return toolError(`No fix "${fixId}" in diagnosis ${diagnosisId}.`);
      }
      if (fix.kind !== 'automatic' || !fix.action) {
        return toolError(
          `"${fix.title}" has to be done by hand.`,
          fix.detail
        );
      }

      const decision = await proposeAndConfirm({
        ctx,
        server,
        serverId: target.id,
        kind: 'apply_fix',
        title: fix.title,
        rationale: reason ?? row.summary ?? undefined,
        payload: { diagnosisId, fixId, action: fix.action },
        question: `${fix.title} on ${target.name}?`,
        details: [fix.detail, '', describeAction(fix.action)],
      });

      if (!decision.approved) {
        return result(decision.message, { applied: false, reason: decision.reason });
      }

      const outcome = await applyAction(ctx, target.id, fix.action);
      recordOutcome(ctx, decision.proposalId, {
        ok: outcome.ok,
        serverId: target.id,
        ...(outcome.ok ? {} : { message: outcome.message }),
      });

      if (!outcome.ok) {
        return toolError(outcome.message);
      }

      ctx.db
        .update(diagnoses)
        .set({ resolvedByProposalId: decision.proposalId })
        .where(eq(diagnoses.id, diagnosisId))
        .run();

      return result(
        `${outcome.message} Run diagnose_server again once it has started to confirm it worked.`,
        { applied: true, fixId, restarted: outcome.restarted }
      );
    }
  );
}

function severityMark(severity: string): string {
  switch (severity) {
    case 'critical':
      return '✗✗';
    case 'error':
      return '✗';
    case 'warning':
      return '!';
    default:
      return '·';
  }
}

function describeAction(action: FixAction): string {
  switch (action.type) {
    case 'set_memory':
      return `Platter will set the memory limit to ${action.memoryMiB} MB and rebuild the container.`;
    case 'change_java_version':
      return `Platter will switch to the Java ${action.java} image and rebuild the container.`;
    case 'remove_mod':
      return 'Platter will delete the mod file and restart the server.';
    case 'install_mod':
      return 'Platter will download the missing dependency and restart the server.';
    case 'set_setting':
      return `Platter will set ${action.key} to ${String(action.value)}.`;
    case 'restore_backup':
      return 'Platter will roll the world back to the most recent backup.';
    case 'accept_eula':
      return "Platter will record acceptance of Mojang's EULA and restart the server.";
    default:
      return 'Platter will apply this change and restart the server.';
  }
}

interface ApplyOutcome {
  ok: boolean;
  message: string;
  restarted: boolean;
}

/**
 * Carry out a declarative fix.
 *
 * The switch is exhaustive on purpose: a new `FixAction` variant added in `@platter/diagnostics`
 * should fail to compile here rather than silently fall through to "unsupported", which is how
 * a fix ends up being offered to a user and then quietly doing nothing.
 */
async function applyAction(
  ctx: Context,
  serverId: string,
  action: FixAction
): Promise<ApplyOutcome> {
  switch (action.type) {
    case 'set_memory': {
      updateServer(ctx.db, serverId, { memoryMiB: action.memoryMiB });
      const rebuilt = await recreateContainer(ctx, serverId, { start: true });
      return isErr(rebuilt)
        ? { ok: false, message: rebuilt.error.message, restarted: false }
        : { ok: true, message: `Memory limit is now ${action.memoryMiB} MB and the server is restarting.`, restarted: true };
    }

    case 'change_java_version': {
      // The image tag is derived from the Minecraft version, so the honest fix here is to
      // rebuild and let `selectImage` reconsider — not to hand-pick a tag that the next rebuild
      // would overwrite anyway.
      const rebuilt = await recreateContainer(ctx, serverId, { start: true });
      return isErr(rebuilt)
        ? { ok: false, message: rebuilt.error.message, restarted: false }
        : { ok: true, message: 'The container was rebuilt on the correct Java image.', restarted: true };
    }

    case 'remove_mod': {
      const server = resolveServer(ctx.db, serverId);
      if (!server) {
        return { ok: false, message: 'Server not found.', restarted: false };
      }
      const needle = action.match.toLowerCase();
      const rows = ctx.db
        .select()
        .from(modInstalls)
        .where(and(eq(modInstalls.serverId, serverId), eq(modInstalls.status, 'installed')))
        .all()
        .filter(
          (row) =>
            row.displayName.toLowerCase().includes(needle) ||
            (row.projectSlug ?? '').toLowerCase().includes(needle) ||
            (row.filePath ?? '').toLowerCase().includes(needle)
        );

      if (rows.length === 0) {
        return { ok: false, message: `Nothing installed matches "${action.match}".`, restarted: false };
      }

      const removed = await removeMods(ctx, server, rows);
      if (isErr(removed)) {
        return { ok: false, message: removed.error.message, restarted: false };
      }
      const restarted = await restartServer(ctx, serverId, { actor: 'ai' });
      return {
        ok: true,
        message: `Removed ${removed.value.removed.join(', ')} and restarted.`,
        restarted: !isErr(restarted),
      };
    }

    case 'set_setting': {
      const updated = await updateSettings(
        ctx,
        serverId,
        { [action.key]: action.value } as Record<string, never>,
        { actor: 'ai' }
      );
      if (isErr(updated)) {
        return { ok: false, message: updated.error.message, restarted: false };
      }
      if (updated.value.restartRequired) {
        const rebuilt = await recreateContainer(ctx, serverId, { start: true });
        return isErr(rebuilt)
          ? { ok: false, message: rebuilt.error.message, restarted: false }
          : { ok: true, message: `Set ${action.key} and restarted.`, restarted: true };
      }
      return { ok: true, message: `Set ${action.key}.`, restarted: false };
    }

    case 'restore_backup': {
      const { listBackups } = await import('@platter/core');
      const backups = listBackups(ctx, serverId).filter((b) => b.status === 'complete');
      const target = action.backupId
        ? backups.find((b) => b.id === action.backupId)
        : backups[0];
      if (!target) {
        return {
          ok: false,
          message: action.backupId
            ? `Backup ${action.backupId} is not available.`
            : 'There are no backups to roll back to.',
          restarted: false,
        };
      }
      const restored = await restoreBackup(ctx, target.id, { actor: 'ai' });
      return isErr(restored)
        ? { ok: false, message: restored.error.message, restarted: false }
        : { ok: true, message: 'Rolled back to the backup.', restarted: true };
    }

    case 'install_mod':
    case 'update_mod': {
      // Deliberately routed back to install_mods rather than handled here. That tool resolves a
      // real downloadable file, runs the compatibility check against what is already installed,
      // and shows the human the dependency list — none of which a bare "install this" can do.
      return {
        ok: false,
        message:
          `This fix installs ${action.ref?.id ?? action.ref?.name ?? 'a mod'}. Use the ` +
          'install_mods tool so it is compatibility-checked and its dependencies resolved first.',
        restarted: false,
      };
    }

    case 'set_loader_version': {
      const server = resolveServer(ctx.db, serverId);
      if (!server) {
        return { ok: false, message: 'Server not found.', restarted: false };
      }
      updateServer(ctx.db, serverId, { loaderVersion: action.version });
      const rebuilt = await recreateContainer(ctx, serverId, { start: true });
      return isErr(rebuilt)
        ? { ok: false, message: rebuilt.error.message, restarted: false }
        : {
            ok: true,
            message: `Pinned ${action.loader} to ${action.version} and rebuilt the container.`,
            restarted: true,
          };
    }

    case 'reallocate_port': {
      // Recreating picks a fresh port when the stored one is no longer bindable. The address
      // changes, so this is worth saying out loud rather than leaving people to discover it.
      const rebuilt = await recreateContainer(ctx, serverId, { start: true });
      if (isErr(rebuilt)) {
        return { ok: false, message: rebuilt.error.message, restarted: false };
      }
      const server = resolveServer(ctx.db, serverId);
      return {
        ok: true,
        message: `Rebuilt on port ${server?.port ?? 'a new port'} — tell anyone who has the old address.`,
        restarted: true,
      };
    }

    case 'retry_start': {
      const started = await restartServer(ctx, serverId, { actor: 'ai' });
      return isErr(started)
        ? { ok: false, message: started.error.message, restarted: false }
        : { ok: true, message: 'Started the server again.', restarted: true };
    }

    case 'repair_permissions':
    case 'free_disk_space': {
      // Both need host-level access Platter deliberately does not have — it drives Docker, it
      // does not chown the host filesystem or delete files it has no claim to. Explaining is
      // more useful than a fix that half-works.
      return {
        ok: false,
        message:
          action.type === 'repair_permissions'
            ? "Platter cannot change ownership on the host. Fix the data directory's permissions " +
              'so uid 1000 can write to it, then start the server again.'
            : `The host is out of disk space${
                action.neededMiB ? ` (about ${action.neededMiB} MB short)` : ''
              }. Free some up — old backups under the Platter data directory are usually the ` +
              'largest thing — then start the server again.',
        restarted: false,
      };
    }

    case 'accept_eula': {
      // Platter always sets EULA=TRUE at creation, so reaching this means the container's
      // eula.txt says false — rebuilding rewrites it.
      const rebuilt = await recreateContainer(ctx, serverId, { start: true });
      return isErr(rebuilt)
        ? { ok: false, message: rebuilt.error.message, restarted: false }
        : { ok: true, message: 'EULA accepted and the server rebuilt.', restarted: true };
    }

    default: {
      const exhaustive: never = action;
      return {
        ok: false,
        message: `Platter does not know how to apply "${(exhaustive as FixAction).type}" yet.`,
        restarted: false,
      };
    }
  }
}
