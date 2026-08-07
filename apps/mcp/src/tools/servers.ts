import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Context,
  describeServer,
  listEvents,
  listPlayers,
  listServers,
  normaliseCommand,
  readLogTail,
  readStats,
  resolveServer,
  restartServer,
  sendCommand,
  startServer,
  stopServer,
} from '@platter/core';
import { isErr, LOADER_LABELS } from '@platter/shared';
import { z } from 'zod';
import { proposeAndConfirm, recordOutcome } from '../confirm';
import {
  describeServerLine,
  formatAgo,
  formatBytes,
  formatMiB,
  result,
  tailText,
  toolError,
} from '../format';
import { isReadOnlyCommand } from '../read-only';

/**
 * Server tools.
 *
 * Read-only tools are annotated as such so hosts can auto-approve them — that is where the
 * usability win lives, and it is why every read tool here sets `readOnlyHint` explicitly rather
 * than relying on defaults (the SDK's defaults assume destructive and open-world).
 *
 * Everything that changes a server goes through `proposeAndConfirm`.
 */
export function registerServerTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'list_servers',
    {
      title: 'List servers',
      description:
        'List every Minecraft server Platter manages, with its status, version, mod loader, ' +
        'address and resource limits. Start here — most other tools need a server id, and this ' +
        'is where you get one.',
      inputSchema: {},
      outputSchema: {
        servers: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: z.string(),
            loader: z.string(),
            gameVersion: z.string(),
            port: z.number(),
            memoryMiB: z.number(),
            statusMessage: z.string().nullable(),
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
    () => {
      const servers = listServers(ctx.db);
      const payload = {
        servers: servers.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          loader: s.loader,
          gameVersion: s.gameVersion,
          port: s.port,
          memoryMiB: s.memoryMiB,
          statusMessage: s.statusMessage,
        })),
      };
      const text =
        servers.length === 0
          ? 'No servers yet. Use create_server to make one.'
          : servers.map((s) => `• ${describeServerLine(s)}`).join('\n');
      return result(text, payload);
    }
  );

  server.registerTool(
    'get_server',
    {
      title: 'Get server details',
      description:
        'Full detail for one server: status, health, runtime versions, resource limits and live ' +
        'CPU/memory when it is running. Accepts an id, a slug or the display name.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
      },
      outputSchema: {
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        status: z.string(),
        statusMessage: z.string().nullable(),
        loader: z.string(),
        gameVersion: z.string(),
        image: z.string(),
        port: z.number(),
        memoryMiB: z.number(),
        cpus: z.number(),
        containerState: z.string().nullable(),
        health: z.enum(['starting', 'healthy', 'unhealthy', 'none']).nullable(),
        exitCode: z.number().nullable(),
        contentDirectory: z.enum(['mods', 'plugins']).nullable(),
        dataDir: z.string(),
        settings: z.record(z.string(), z.unknown()),
        stats: z
          .object({
            cpuPercent: z.number(),
            memoryUsedBytes: z.number(),
            memoryLimitBytes: z.number(),
            memoryPercent: z.number(),
            networkRxBytes: z.number(),
            networkTxBytes: z.number(),
            blockReadBytes: z.number(),
            blockWriteBytes: z.number(),
            pids: z.number(),
            at: z.number(),
          })
          .nullable(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ server: reference }) => {
      const found = resolveServer(ctx.db, reference);
      if (!found) {
        return toolError(
          `No server matching "${reference}".`,
          'Call list_servers to see what exists.'
        );
      }

      const described = await describeServer(ctx, found.id);
      if (isErr(described)) {
        return toolError(described.error.message);
      }
      const { server: s, containerState, health, exitCode, contentDirectory } = described.value;

      const stats =
        s.containerId && s.status === 'running'
          ? await readStats(ctx.docker, s.containerId)
          : undefined;

      const lines = [
        `${s.name} — ${s.status}`,
        `${LOADER_LABELS[s.loader]} ${s.gameVersion}, Java image ${s.image}`,
        `Address: localhost:${s.port}`,
        `Limits: ${formatMiB(s.memoryMiB)} memory, ${s.cpus} CPU cores`,
        `Add-ons go in /data/${contentDirectory ?? '(this server takes neither mods nor plugins)'}`,
      ];
      if (s.statusMessage) {
        lines.push(`Note: ${s.statusMessage}`);
      }
      if (exitCode !== undefined && s.status !== 'running') {
        lines.push(
          `Last exit code: ${exitCode}${exitCode === 137 ? ' (killed — usually out of memory)' : ''}`
        );
      }
      if (stats?.ok) {
        lines.push(
          `Now: ${stats.value.cpuPercent.toFixed(1)}% CPU, ` +
            `${formatBytes(stats.value.memoryUsedBytes)} of ${formatBytes(stats.value.memoryLimitBytes)} memory, ` +
            `${stats.value.pids} threads`
        );
      }

      return result(lines.join('\n'), {
        id: s.id,
        name: s.name,
        slug: s.slug,
        status: s.status,
        statusMessage: s.statusMessage,
        loader: s.loader,
        gameVersion: s.gameVersion,
        image: s.image,
        port: s.port,
        memoryMiB: s.memoryMiB,
        cpus: s.cpus,
        containerState: containerState ?? null,
        health: health ?? null,
        exitCode: exitCode ?? null,
        contentDirectory,
        dataDir: s.dataDir,
        settings: s.settings,
        stats: stats?.ok ? stats.value : null,
      });
    }
  );

  server.registerTool(
    'get_server_logs',
    {
      title: 'Read server logs',
      description:
        "Read the tail of a server's console output. This is the raw log — for an interpreted " +
        'answer about why something is broken, use diagnose_server instead.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        lines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(300)
          .describe('How many lines from the end'),
        grep: z
          .string()
          .optional()
          .describe('Only return lines matching this (case-insensitive substring)'),
      },
      outputSchema: {
        server: z.string(),
        lineCount: z.number(),
        truncated: z.boolean(),
        lines: z.array(
          z.object({
            text: z.string(),
            stream: z.enum(['stdout', 'stderr']),
            timestamp: z.number().nullable(),
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
    async ({ server: reference, lines, grep }) => {
      const found = resolveServer(ctx.db, reference);
      if (!found) {
        return toolError(`No server matching "${reference}".`);
      }
      if (!found.containerId) {
        return toolError(`${found.name} has no container, so there are no logs yet.`);
      }

      const tail = await readLogTail(ctx.docker, found.containerId, lines);
      if (isErr(tail)) {
        return toolError(tail.error.message);
      }

      const needle = grep?.toLowerCase();
      const selected = needle
        ? tail.value.filter((line) => line.text.toLowerCase().includes(needle))
        : tail.value;

      const text = selected.map((line) => line.text).join('\n');

      return result(
        selected.length === 0
          ? grep
            ? `No lines matching "${grep}" in the last ${lines} lines.`
            : 'The log is empty.'
          : tailText(text),
        {
          server: found.id,
          lineCount: selected.length,
          truncated: selected.length < tail.value.length,
          lines: selected.map((line) => ({
            text: line.text,
            stream: line.stream,
            timestamp: line.timestamp ?? null,
          })),
        }
      );
    }
  );

  server.registerTool(
    'get_players',
    {
      title: 'List online players',
      description:
        'Who is currently connected. Requires the server to be running and answering RCON.',
      inputSchema: { server: z.string().describe('Server id, slug or name') },
      outputSchema: {
        online: z.number(),
        max: z.number(),
        names: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ server: reference }) => {
      const found = resolveServer(ctx.db, reference);
      if (!found) {
        return toolError(`No server matching "${reference}".`);
      }
      if (found.status !== 'running' || !found.rconPort) {
        return toolError(`${found.name} is ${found.status}, so nobody can be connected.`);
      }

      const players = await listPlayers({
        serverId: found.id,
        host: '127.0.0.1',
        port: found.rconPort,
        password: found.rconPassword,
      });
      if (isErr(players)) {
        return toolError(players.error.message);
      }

      return result(
        players.value.online === 0
          ? `Nobody is online (capacity ${players.value.max}).`
          : `${players.value.online}/${players.value.max} online: ${players.value.names.join(', ')}`,
        players.value
      );
    }
  );

  server.registerTool(
    'get_activity',
    {
      title: 'Read the activity log',
      description:
        'Recent events for a server, or across all servers. Includes what AI agents proposed ' +
        'and what humans approved, so you can see the history of changes.',
      inputSchema: {
        server: z.string().optional().describe('Server id, slug or name. Omit for all servers.'),
        limit: z.number().int().min(1).max(200).default(40),
      },
      outputSchema: {
        events: z.array(
          z.object({
            id: z.string(),
            serverId: z.string().nullable(),
            type: z.string(),
            level: z.string(),
            actor: z.string(),
            message: z.string(),
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
    ({ server: reference, limit }) => {
      const found = reference ? resolveServer(ctx.db, reference) : undefined;
      if (reference && !found) {
        return toolError(`No server matching "${reference}".`);
      }

      const events = listEvents(ctx.db, { ...(found ? { serverId: found.id } : {}), limit });
      const text =
        events.length === 0
          ? 'Nothing has happened yet.'
          : events
              .map((e) => `${formatAgo(e.createdAt)} · ${e.actor} · ${e.type} · ${e.message}`)
              .join('\n');

      return result(text, {
        events: events.map((e) => ({
          id: e.id,
          serverId: e.serverId,
          type: e.type,
          level: e.level,
          actor: e.actor,
          message: e.message,
          createdAt: e.createdAt,
        })),
      });
    }
  );

  /* ---------------------------------------------------------------------- */
  /* Mutating tools                                                          */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    'run_command',
    {
      title: 'Run a server command',
      description:
        'Run a Minecraft console command over RCON and return its output — the same thing you ' +
        'would type in the server console. Read-only commands (list, seed, whitelist list) run ' +
        'immediately; anything that changes state asks for confirmation first.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        command: z.string().describe('The command, with or without a leading slash'),
      },
      outputSchema: {
        ran: z.boolean(),
        reason: z
          .enum(['declined', 'cancelled', 'unsupported'])
          .optional()
          .describe('Present when a confirmation was declined instead of run'),
        channel: z.enum(['rcon', 'stdin']).optional(),
        response: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ server: reference, command }) => {
      const found = resolveServer(ctx.db, reference);
      if (!found) {
        return toolError(`No server matching "${reference}".`);
      }

      // Reject multi-line input here as well as in core, so the confirmation decision below is
      // made about the same single command that will actually run.
      const normalised = normaliseCommand(command);
      if (isErr(normalised)) {
        return toolError(normalised.error.message);
      }
      const single = normalised.value;

      // Inspection commands are safe, and asking about them would make the tool tedious enough
      // that a host would be tempted to auto-approve everything. See `read-only.ts` for why the
      // exemption is keyed on the whole command rather than its first word.
      if (!isReadOnlyCommand(single)) {
        const decision = await proposeAndConfirm({
          ctx,
          server,
          serverId: found.id,
          kind: 'run_command',
          title: `Run /${single} on ${found.name}`,
          payload: { command: single },
          question: `Run "/${single}" on ${found.name}?`,
          details: ['This runs on the live server and takes effect immediately.'],
        });
        if (!decision.approved) {
          return result(decision.message, { ran: false, reason: decision.reason });
        }

        const response = await sendCommand(ctx, found.id, single, { actor: 'ai' });
        recordOutcome(ctx, decision.proposalId, {
          ok: !isErr(response),
          serverId: found.id,
          ...(isErr(response) ? { message: response.error.message } : { result: response.value }),
        });
        if (isErr(response)) {
          return toolError(response.error.message);
        }
        return result(response.value.response || '(no output)', {
          ran: true,
          channel: response.value.channel,
          response: response.value.response,
        });
      }

      const response = await sendCommand(ctx, found.id, single, { actor: 'ai' });
      if (isErr(response)) {
        return toolError(response.error.message);
      }
      return result(response.value.response || '(no output)', {
        ran: true,
        channel: response.value.channel,
        response: response.value.response,
      });
    }
  );

  server.registerTool(
    'control_server',
    {
      title: 'Start, stop or restart a server',
      description:
        "Change a server's running state. Stopping or restarting disconnects players, so both " +
        'ask for confirmation. Starting an already-stopped server also confirms, because it ' +
        'begins consuming resources.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        action: z.enum(['start', 'stop', 'restart']),
        reason: z.string().optional().describe('Why — shown to the human deciding'),
      },
      outputSchema: {
        done: z.boolean(),
        reason: z
          .enum(['declined', 'cancelled', 'unsupported'])
          .optional()
          .describe('Present when a confirmation was declined instead of applied'),
        action: z.enum(['start', 'stop', 'restart']).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ server: reference, action, reason }) => {
      const found = resolveServer(ctx.db, reference);
      if (!found) {
        return toolError(`No server matching "${reference}".`);
      }

      const online =
        found.status === 'running' && found.rconPort
          ? await listPlayers({
              serverId: found.id,
              host: '127.0.0.1',
              port: found.rconPort,
              password: found.rconPassword,
            })
          : undefined;

      const details: string[] = [];
      if (online?.ok && online.value.online > 0) {
        details.push(
          `${online.value.online} player${online.value.online === 1 ? '' : 's'} online right now: ` +
            online.value.names.join(', ')
        );
      }
      if (action !== 'start') {
        details.push('The world is saved before shutdown, so nothing is lost.');
      }

      const decision = await proposeAndConfirm({
        ctx,
        server,
        serverId: found.id,
        kind: action,
        title: `${action} ${found.name}`,
        rationale: reason,
        payload: { action },
        impact: {
          disconnectsPlayers: action !== 'start',
          playersOnline: online?.ok ? online.value.online : null,
        },
        question: `${action === 'start' ? 'Start' : action === 'stop' ? 'Stop' : 'Restart'} ${found.name}?`,
        details,
      });

      if (!decision.approved) {
        return result(decision.message, { done: false, reason: decision.reason });
      }

      const run =
        action === 'start'
          ? startServer(ctx, found.id, { actor: 'ai' })
          : action === 'stop'
            ? stopServer(ctx, found.id, { actor: 'ai' })
            : restartServer(ctx, found.id, { actor: 'ai' });

      const outcome = await run;
      recordOutcome(ctx, decision.proposalId, {
        ok: !isErr(outcome),
        serverId: found.id,
        ...(isErr(outcome) ? { message: outcome.error.message } : {}),
      });

      if (isErr(outcome)) {
        return toolError(outcome.error.message);
      }
      return result(
        action === 'stop'
          ? `${found.name} is stopping.`
          : `${found.name} is starting. It takes a minute or two before players can join; poll ` +
              'get_server until the status is "running".',
        { done: true, action }
      );
    }
  );
}
