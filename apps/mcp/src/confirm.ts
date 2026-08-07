import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from '@platter/core';
import { EVENT, emitEvent } from '@platter/core';
import { proposals } from '@platter/db';
import { ulid } from '@platter/shared';
import { eq } from 'drizzle-orm';

/**
 * Human confirmation for anything destructive.
 *
 * This is the mechanism the whole AI story rests on. An agent can search mods, read logs and
 * form an opinion freely — but installing a mod, restarting a server or rolling back a world is
 * a decision with consequences the model does not have to live with, so a person makes it.
 *
 * Three properties are deliberate:
 *
 *   1. **The proposal is recorded before the question is asked.** If the model proposes
 *      something and the human accepts, there is a row explaining what was suggested, why, and
 *      what the compatibility check said at the time. "The AI installed something and now the
 *      server is broken" becomes answerable.
 *
 *   2. **Decline and cancel are treated identically.** The MCP spec distinguishes an explicit
 *      "no" from a dismissed dialog, and it is tempting to retry on the latter. Both mean the
 *      change was not authorised, and acting on a dismissal is exactly the behaviour that would
 *      make people stop trusting this.
 *
 *   3. **There is no bypass.** No auto-approve flag, no "trusted mode". If a client does not
 *      support elicitation, the tool refuses and explains — it does not silently proceed.
 */

export type Decision =
  | { approved: true; proposalId: string; note?: string | undefined }
  | {
      approved: false;
      proposalId: string;
      reason: 'declined' | 'cancelled' | 'unsupported';
      message: string;
    };

export interface ProposeOptions {
  ctx: Context;
  server: McpServer;
  serverId?: string | undefined;
  /** install_mods | remove_mods | update_mods | change_settings | restart | restore_backup | apply_fix */
  kind: string;
  title: string;
  /** The model's reasoning, shown verbatim to the human. */
  rationale?: string | undefined;
  /** Exactly what will change. Stored and rendered. */
  payload: Record<string, unknown>;
  /** Compatibility verdict, when one applies. */
  compatReport?: unknown;
  /** Impact estimate: restart needed, worldgen affected, data destroyed. */
  impact?: Record<string, unknown> | undefined;
  /**
   * Message shown in the confirmation dialog. Should be specific and mention consequences —
   * "Install Lithium 0.14.3 (server-side, no restart needed)?" beats "Apply changes?".
   */
  question: string;
  /** Extra detail lines rendered under the question. */
  details?: string[];
}

export async function proposeAndConfirm(options: ProposeOptions): Promise<Decision> {
  const { ctx, server, kind, title, payload } = options;

  const proposalId = ulid();
  ctx.db
    .insert(proposals)
    .values({
      id: proposalId,
      serverId: options.serverId ?? null,
      kind,
      title,
      rationale: options.rationale ?? null,
      payload,
      compatReport: options.compatReport ?? null,
      impact: options.impact ?? null,
      status: 'pending',
      source: 'mcp',
      // A proposal nobody answers should not linger as a pending decision forever.
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    .run();

  emitEvent(ctx.db, {
    serverId: options.serverId ?? null,
    type: EVENT.proposalCreated,
    message: title,
    actor: 'ai',
    data: { proposalId, kind },
  });

  // Elicitation is a client capability. Without it there is no way to ask, and proceeding
  // anyway would be exactly the behaviour this module exists to prevent.
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.elicitation) {
    const message =
      'This action changes the server, so it needs your confirmation — but this MCP client ' +
      'does not support confirmation prompts. Approve it in the Platter UI instead ' +
      `(proposal ${proposalId}).`;
    recordDecision(ctx, proposalId, 'rejected', 'client-unsupported', message);
    return { approved: false, proposalId, reason: 'unsupported', message };
  }

  const body = [options.question, ...(options.details ?? [])].join('\n');

  const answer = await server.server.elicitInput({
    message: body,
    requestedSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          title: 'Apply this change?',
          description: 'Platter will only proceed if you say yes.',
        },
        note: {
          type: 'string',
          title: 'Note (optional)',
          description: 'Recorded in the activity log alongside your decision.',
          maxLength: 200,
        },
      },
      required: ['confirm'],
    },
  });

  // `content` is client-supplied and therefore untrusted; `required` is a hint, not a
  // guarantee. Anything other than an explicit true is a no.
  const confirmed = answer.action === 'accept' && answer.content?.confirm === true;
  const note = typeof answer.content?.note === 'string' ? answer.content.note : undefined;

  if (confirmed) {
    recordDecision(ctx, proposalId, 'accepted', 'human', note);
    emitEvent(ctx.db, {
      serverId: options.serverId ?? null,
      type: EVENT.proposalAccepted,
      message: `Approved: ${title}`,
      actor: 'user',
      data: { proposalId, ...(note ? { note } : {}) },
    });
    return { approved: true, proposalId, note };
  }

  const reason = answer.action === 'decline' ? 'declined' : 'cancelled';
  const message =
    reason === 'declined'
      ? 'You declined this change. Nothing was modified.'
      : 'The confirmation was dismissed, so nothing was modified.';

  recordDecision(ctx, proposalId, 'rejected', 'human', note ?? message);
  emitEvent(ctx.db, {
    serverId: options.serverId ?? null,
    type: EVENT.proposalRejected,
    message: `Rejected: ${title}`,
    actor: 'user',
    data: { proposalId, reason },
  });

  return { approved: false, proposalId, reason, message };
}

function recordDecision(
  ctx: Context,
  proposalId: string,
  status: 'accepted' | 'rejected',
  decidedBy: string,
  note?: string | undefined
): void {
  ctx.db
    .update(proposals)
    .set({
      status,
      decidedBy,
      decisionNote: note ?? null,
      decidedAt: Date.now(),
    })
    .where(eq(proposals.id, proposalId))
    .run();
}

/** Record what happened after an approved proposal was carried out. */
export function recordOutcome(
  ctx: Context,
  proposalId: string,
  outcome: { ok: boolean; result?: unknown; message?: string; serverId?: string | undefined }
): void {
  ctx.db
    .update(proposals)
    .set({
      status: outcome.ok ? 'applied' : 'failed',
      result: (outcome.result ?? { message: outcome.message }) as Record<string, unknown>,
      appliedAt: Date.now(),
    })
    .where(eq(proposals.id, proposalId))
    .run();

  emitEvent(ctx.db, {
    serverId: outcome.serverId ?? null,
    type: outcome.ok ? EVENT.proposalApplied : EVENT.proposalFailed,
    level: outcome.ok ? 'info' : 'error',
    message: outcome.ok
      ? `Applied proposal ${proposalId}`
      : `Proposal ${proposalId} failed: ${outcome.message ?? 'unknown error'}`,
    actor: 'ai',
    data: { proposalId },
  });
}
