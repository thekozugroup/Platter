import type { Resource, ResourceTemplate, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { formatAddress, listServersQuerySchema } from '@platter/shared';
import { MINECRAFT_SERVER_TYPES } from '../blueprints/index.js';
import { prisma } from '../db.js';
import { getBlueprint, hasBlueprint, listBlueprintSummaries } from '../services/blueprints.js';
import { listServers, loadServerDto, presentStatus } from '../services/servers.js';
import { authorizeServer } from './auth.js';
import { readRecentLines, toLogEntries, type ToolContext } from './tools.js';

/**
 * Read-only views an MCP client can subscribe to instead of calling a tool.
 *
 * Resources are for context an agent wants *before* it knows what it is doing — "what servers
 * are there", "what games can this install run" — which is exactly the material a client
 * wants to attach to a conversation rather than spend a tool call on. Everything here is a
 * projection of what the equivalent tool returns, under the same authorisation: a resource is
 * not a back door around `server.view`.
 *
 * Nothing here mutates, and there is deliberately no resource that exposes a secret: server
 * config goes through the same password redaction `get_server` uses.
 */

export const RESOURCE_SCHEME = 'platter';

/**
 * JSON-RPC code the MCP spec reserves for "that resource does not exist". It is outside the
 * SDK's `ErrorCode` enum, which only carries the base JSON-RPC set.
 */
const RESOURCE_NOT_FOUND = -32002;

/** Resource lists are enumerated eagerly, so they are capped like everything else. */
const MAX_LISTED_SERVERS = 25;
const RESOURCE_LOG_LINES = 200;

const SERVERS_URI = `${RESOURCE_SCHEME}://servers`;
const BLUEPRINTS_URI = `${RESOURCE_SCHEME}://blueprints`;

function serverConfigUri(serverId: string): string {
  return `${RESOURCE_SCHEME}://servers/${serverId}/config`;
}

function serverLogsUri(serverId: string): string {
  return `${RESOURCE_SCHEME}://servers/${serverId}/logs`;
}

export const PLATTER_RESOURCE_TEMPLATES: readonly ResourceTemplate[] = [
  {
    uriTemplate: `${RESOURCE_SCHEME}://servers/{serverId}/config`,
    name: 'server-config',
    title: 'Server configuration',
    description:
      "One server's stored configuration: status, resource limits, port allocations and blueprint " +
      'variables. Password variables are redacted. Same data as the get_server tool.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: `${RESOURCE_SCHEME}://servers/{serverId}/logs`,
    name: 'server-logs',
    title: 'Recent console output',
    description:
      `The last ${RESOURCE_LOG_LINES} console lines for one server, as plain text, oldest first. ` +
      'A snapshot, not a live stream.',
    mimeType: 'text/plain',
  },
];

const STATIC_RESOURCES: readonly Resource[] = [
  {
    uri: SERVERS_URI,
    name: 'servers',
    title: 'Game servers',
    description:
      'Every game server this API key can see, with status, node and primary address. The same ' +
      'list the list_servers tool returns, capped at the most recent ' +
      `${MAX_LISTED_SERVERS}.`,
    mimeType: 'application/json',
  },
  {
    uri: BLUEPRINTS_URI,
    name: 'blueprints',
    title: 'Blueprint catalogue',
    description:
      'Every game this Platter install can provision, with its memory and disk minimums, plus the ' +
      'full Minecraft: Java server-type matrix (Paper, Fabric, Forge, …) and what each one accepts.',
    mimeType: 'application/json',
  },
];

export const PLATTER_RESOURCES = STATIC_RESOURCES;

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * The two fixed resources, plus a config and a logs resource per visible server.
 *
 * Enumerating servers here is what lets a client show them as attachable context without
 * calling a tool first. It is bounded: on an install with hundreds of servers the list is
 * the most recent `MAX_LISTED_SERVERS`, and the templates above remain the way to reach the
 * rest by id.
 */
export async function listResources(context: ToolContext): Promise<Resource[]> {
  const resources: Resource[] = [...STATIC_RESOURCES];

  // `server.view` is not asserted as a scope here: a key without it simply sees no servers,
  // because the query below is scoped to what its owner may read.
  if (context.principal.scopes !== null && !context.principal.scopes.has('server.view')) {
    return resources;
  }

  const page = await listServers(
    listServersQuerySchema.parse({ page: 1, perPage: MAX_LISTED_SERVERS }),
    context.principal.user,
  );

  for (const server of page.data) {
    resources.push({
      uri: serverConfigUri(server.id),
      name: `${server.name} — configuration`,
      description: `Stored configuration for ${server.name} (${server.blueprintKey}, ${server.status}).`,
      mimeType: 'application/json',
    });
    resources.push({
      uri: serverLogsUri(server.id),
      name: `${server.name} — console`,
      description: `The last ${RESOURCE_LOG_LINES} console lines for ${server.name}.`,
      mimeType: 'text/plain',
    });
  }

  return resources;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const SERVER_URI_PATTERN = new RegExp(`^${RESOURCE_SCHEME}://servers/([^/]+)/(config|logs)$`);

function json(uri: string, body: unknown): ReadResourceResult {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }],
  };
}

function text(uri: string, body: string): ReadResourceResult {
  return { contents: [{ uri, mimeType: 'text/plain', text: body }] };
}

async function readServerList(context: ToolContext): Promise<ReadResourceResult> {
  const page = await listServers(
    listServersQuerySchema.parse({ page: 1, perPage: MAX_LISTED_SERVERS }),
    context.principal.user,
  );
  return json(SERVERS_URI, {
    servers: page.data,
    total: page.meta.total,
    truncated: page.meta.total > page.data.length,
  });
}

function readBlueprints(): ReadResourceResult {
  return json(BLUEPRINTS_URI, {
    blueprints: listBlueprintSummaries(),
    minecraftServerTypes: MINECRAFT_SERVER_TYPES,
    note: 'Blueprint keys are what create_server takes as blueprintKey. minecraftServerTypes are the values the minecraft-java TYPE variable accepts.',
  });
}

async function readServerConfig(serverId: string, context: ToolContext): Promise<ReadResourceResult> {
  const uri = serverConfigUri(serverId);
  const row = await authorizeServer(context.principal, serverId, 'server.view');
  const dto = await loadServerDto(row.id, context.logger);
  const blueprint = hasBlueprint(row.blueprintKey) ? getBlueprint(row.blueprintKey) : null;
  const node = await prisma.node.findUnique({
    where: { id: row.nodeId },
    select: { name: true, publicHost: true },
  });

  return json(uri, {
    id: dto.id,
    name: dto.name,
    description: dto.description,
    status: dto.status,
    blueprint: blueprint
      ? { key: blueprint.key, name: blueprint.name, game: blueprint.game, features: blueprint.features }
      : { key: dto.blueprintKey, name: null, game: null, features: null },
    node: node ? { id: dto.nodeId, name: node.name, publicHost: node.publicHost } : null,
    limits: dto.limits,
    allocations: dto.allocations.map((allocation) => ({
      ...allocation,
      address: node ? formatAddress(node.publicHost, allocation.hostPort) : null,
    })),
    connectString: dto.connectString,
    variables: dto.variables,
    redactedVariables: dto.redactedVariables,
    autoStart: dto.autoStart,
    autoRestart: dto.autoRestart,
    installedAt: dto.installedAt,
    startedAt: dto.startedAt,
    lastExitCode: dto.lastExitCode,
    lastCrashAt: dto.lastCrashAt,
  });
}

async function readServerLogs(serverId: string, context: ToolContext): Promise<ReadResourceResult> {
  const uri = serverLogsUri(serverId);
  const row = await authorizeServer(context.principal, serverId, 'console.read');
  const read = await readRecentLines(row, RESOURCE_LOG_LINES, context.signal);

  if (read.unavailable !== null && read.lines.length === 0) {
    return text(uri, `# ${row.name} (${presentStatus(row)})\n# ${read.unavailable}\n`);
  }

  const body = toLogEntries(read.lines)
    .map((entry) => `${entry.timestamp} ${entry.stream === 'stderr' ? 'ERR' : 'OUT'} ${entry.content}`)
    .join('\n');

  return text(uri, `# ${row.name} (${presentStatus(row)}) — last ${read.lines.length} lines\n${body}\n`);
}

/**
 * Resolves one resource URI.
 *
 * An unknown URI is a JSON-RPC error rather than empty contents: "there is no such resource"
 * and "that resource is empty" are different answers, and a client that cannot tell them
 * apart will happily attach nothing to a conversation and never say so.
 */
export async function readResource(uri: string, context: ToolContext): Promise<ReadResourceResult> {
  if (uri === SERVERS_URI) return readServerList(context);
  if (uri === BLUEPRINTS_URI) return readBlueprints();

  const match = SERVER_URI_PATTERN.exec(uri);
  const serverId = match?.[1];
  if (match && serverId !== undefined) {
    return match[2] === 'config'
      ? readServerConfig(decodeURIComponent(serverId), context)
      : readServerLogs(decodeURIComponent(serverId), context);
  }

  throw new McpError(RESOURCE_NOT_FOUND, `No resource at ${uri}`);
}
