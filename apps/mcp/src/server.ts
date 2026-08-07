import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, listServers, resolveServer } from '@platter/core';
import { LOADER_LABELS } from '@platter/shared';
import { registerBackupTools } from './tools/backups';
import { registerDiagnosticTools } from './tools/diagnose';
import { registerModTools } from './tools/mods';
import { registerServerTools } from './tools/servers';

export const SERVER_NAME = 'platter';
export const SERVER_VERSION = '0.1.0';

/**
 * Build the MCP server.
 *
 * The instruction block is doing real work. A model that reaches for `install_mods` without
 * running `check_mod` will produce a broken server and a confused human, and no amount of
 * per-tool description reliably prevents that — stating the workflow once, up front, does.
 */
export function createMcpServer(ctx: Context): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        logging: {},
        resources: { listChanged: true },
      },
      instructions: [
        'Platter manages Minecraft servers in Docker on this machine.',
        '',
        'Workflow that works:',
        '  1. list_servers to find the server, then get_server for detail.',
        '  2. For problems: diagnose_server before guessing. It reads the logs and names the',
        '     cause. apply_fix carries out what it suggests.',
        '  3. For mods: search_mods to find candidates, then check_mod on each one. Search',
        '     results describe everything a project has EVER supported, not one downloadable',
        '     file — check_mod is the only authoritative answer for a specific server.',
        '     install_mods pulls in dependencies automatically.',
        '',
        'Anything that changes a server asks the human to confirm, and shows them exactly what',
        'will change. You cannot bypass this, and you should not try — propose clearly and let',
        'them decide. If a confirmation is declined, do not retry it in another form.',
        '',
        'Mods only load after a restart. Say so rather than leaving someone wondering why',
        'nothing changed.',
      ].join('\n'),
    }
  );

  registerServerTools(server, ctx);
  registerModTools(server, ctx);
  registerBackupTools(server, ctx);
  registerDiagnosticTools(server, ctx);
  registerResources(server, ctx);

  return server;
}

/**
 * Resources, for clients that let a user attach context directly.
 *
 * Deliberately few. Resources are pulled into context wholesale by the human rather than
 * requested by the model, so the useful ones are the ones a person would reach for while asking
 * a question — the server list, and one server's current state.
 */
function registerResources(server: McpServer, ctx: Context): void {
  server.registerResource(
    'servers',
    'platter://servers',
    {
      title: 'All servers',
      description: 'Every server Platter manages, with status and configuration.',
      mimeType: 'application/json',
    },
    () => ({
      contents: [
        {
          uri: 'platter://servers',
          mimeType: 'application/json',
          text: JSON.stringify(
            listServers(ctx.db).map((s) => ({
              id: s.id,
              name: s.name,
              status: s.status,
              loader: LOADER_LABELS[s.loader],
              gameVersion: s.gameVersion,
              address: `localhost:${s.port}`,
              memoryMiB: s.memoryMiB,
            })),
            null,
            2
          ),
        },
      ],
    })
  );

  server.registerResource(
    'server',
    'platter://server/{id}',
    {
      title: 'One server',
      description: 'Full configuration and status for a single server.',
      mimeType: 'application/json',
    },
    (uri: URL) => {
      const id = uri.pathname.replace(/^\/+/, '') || uri.hostname;
      const found = resolveServer(ctx.db, id);
      if (!found) {
        return {
          contents: [
            { uri: uri.href, mimeType: 'text/plain', text: `No server matching "${id}".` },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                id: found.id,
                name: found.name,
                status: found.status,
                statusMessage: found.statusMessage,
                loader: found.loader,
                gameVersion: found.gameVersion,
                address: `localhost:${found.port}`,
                memoryMiB: found.memoryMiB,
                cpus: found.cpus,
                settings: found.settings,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
