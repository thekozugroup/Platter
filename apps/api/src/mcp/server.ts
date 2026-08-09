import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger } from 'fastify';
import type { PlatterError } from '@platter/shared';
import { toPlatterError } from '../lib/errors.js';
import { PLATTER_RESOURCE_TEMPLATES, listResources, readResource } from './resources.js';
import { PLATTER_TOOLS, getTool, type ToolContext } from './tools.js';
import { principalLabel, type McpPrincipal } from './auth.js';

/**
 * One MCP server instance, bound to one API key.
 *
 * The binding is the point: a session's authority comes from the key it was opened with and
 * cannot be changed by anything the client sends. There is no "act as" argument on any tool,
 * so a compromised or confused agent cannot escalate past the key it was handed. What the key
 * itself may do is re-read on every call (see `McpServerOptions.principal`), so an operator
 * who narrows or revokes a key does not have to wait out a session to make it stick.
 *
 * This is built on the SDK's low-level `Server` rather than `McpServer`, for one reason: the
 * MCP specification distinguishes *protocol* errors (unknown tool, invalid arguments — the
 * call never happened) from *execution* errors (the call happened and failed, reported as a
 * result with `isError`). `McpServer` collapses both into `isError`, which leaves an agent
 * unable to tell "you called a tool that does not exist" from "the server is already
 * running". Handling the requests directly keeps that distinction, and keeps the tool
 * manifest exactly what `tools.ts` declares.
 */

const require = createRequire(import.meta.url);
const APP_VERSION: string = (require('../../package.json') as { version: string }).version;

export const MCP_SERVER_NAME = 'platter';

/**
 * The text half of a tool result is a spec-mandated duplicate of `structuredContent`, for
 * clients that predate structured output. Every tool bounds its own payload, so this only
 * ever trims the duplicate — and it trims the copy, never the structured original.
 */
const MAX_TEXT_RESULT_BYTES = 128 * 1024;

/**
 * Shown to the model once, at connect. It is the only place to state the rules that are not
 * visible from any single tool's description.
 */
const INSTRUCTIONS = [
  'Platter is a control panel for self-hosted game servers. These tools manage real servers that real people play on.',
  '',
  'Three things to hold on to:',
  '',
  '1. You cannot install a mod. `propose_mod` writes a proposal that a human approves in the Platter web UI, and there is no tool here that installs, updates or removes a file. When you recommend a mod, propose it and then tell the person what to look at before they approve — the licence, how maintained it is, what it pulls in with it.',
  '2. Destructive tools refuse to act unless you pass the confirmation argument. That refusal is a feature: read what the tool says would happen, relay it, and only confirm when the person has actually asked for that specific thing. Deleting a server destroys its worlds and cannot be undone.',
  '3. You act as a specific Platter account through a specific API key. Every server you cannot see is a server you have no access to, and every write is written to the audit log with your identity on it. If a tool says you lack a permission, say so — do not look for another route to the same effect.',
  '',
  'Start with `list_servers` and `list_blueprints`. For anything Minecraft, read `get_blueprint("minecraft-java")` before choosing a server type: Paper takes Bukkit plugins, Fabric takes Fabric mods, and they are not interchangeable.',
].join('\n');

function toToolDescriptor(tool: {
  name: string;
  title: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  outputSchema?: Tool['outputSchema'];
  annotations: Tool['annotations'];
}): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

/** Precomputed: the manifest is identical for every session and does not depend on the caller. */
const TOOL_DESCRIPTORS: readonly Tool[] = PLATTER_TOOLS.map((tool) =>
  toToolDescriptor({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  }),
);

/**
 * Renders a failure as something an agent can act on.
 *
 * The stable `ErrorCode` leads, because that is what a client should branch on, and the
 * message is Platter's own copy — never a driver's or Prisma's, which is why everything goes
 * through `toPlatterError` first. Field-level details are appended for validation failures:
 * an agent that is told which argument was wrong can fix it, and one that is told "some
 * fields need attention" will guess.
 */
function describeError(error: PlatterError): string {
  const lines = [`${error.code}: ${error.message}`];
  if (error.details) {
    for (const [field, messages] of Object.entries(error.details)) {
      lines.push(`  ${field}: ${messages.join(' ')}`);
    }
  }
  if (error.retryable) lines.push('This is worth retrying.');
  return lines.join('\n');
}

function toolResult(structured: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify(structured);
  return {
    content: [
      {
        type: 'text',
        text:
          text.length > MAX_TEXT_RESULT_BYTES
            ? `[${text.length} bytes of JSON omitted from this text block; the full result is in structuredContent]`
            : text,
      },
    ],
    structuredContent: structured,
  };
}

export interface McpServerOptions {
  /**
   * Read on every request rather than captured once.
   *
   * A streamable-HTTP session lives up to half an hour and re-presents its key on every
   * message, so the key's *current* scopes are knowable — but they were snapshotted at
   * `initialize`, which meant narrowing a key's scopes did not take effect until the
   * session ended. Revocation and suspension were re-checked; narrowing was not, and
   * "I have reduced what that agent may do" is exactly the action an operator takes when
   * they are already worried.
   */
  principal: () => McpPrincipal;
  logger: FastifyBaseLogger;
}

/**
 * Builds a server ready to be handed a transport. The caller owns `connect` and `close`.
 */
export function createMcpServer(options: McpServerOptions): Server {
  const { principal: currentPrincipal, logger } = options;
  // Only for log context and the capacity check, which need *a* key id; the identity of the
  // key cannot change within a session — `routes/mcp.ts` refuses a different one.
  const principal = currentPrincipal();

  const server = new Server(
    { name: MCP_SERVER_NAME, title: 'Platter', version: APP_VERSION },
    {
      capabilities: {
        // No `listChanged` on either: the tool manifest is static, and resource membership
        // changes with the database rather than through anything this session did, so
        // advertising a notification we would never send would be a lie.
        tools: {},
        resources: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  function contextFor(signal: AbortSignal): ToolContext {
    // Read at call time, not at construction: `clientInfo` only exists after `initialize`,
    // and the principal's scopes may have been narrowed since the session opened.
    const client = server.getClientVersion();
    const live = currentPrincipal();
    return {
      principal: live,
      actorName: principalLabel(live, client?.name ?? null),
      signal,
      logger,
    };
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOL_DESCRIPTORS] }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = getTool(request.params.name);
    // A tool that does not exist is a protocol error: the call never ran, and returning it as
    // a tool result would tell an agent its arguments were wrong rather than its tool name.
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }

    try {
      const structured = await tool.run(request.params.arguments, contextFor(extra.signal));
      return toolResult(structured);
    } catch (error) {
      // Argument validation raises `McpError` from inside `run`; that is a protocol error and
      // is rethrown rather than dressed up as a result.
      if (error instanceof McpError) throw error;

      const platter = toPlatterError(error);
      if (platter.code === 'internal_error') {
        logger.error(
          { err: error, tool: tool.name, apiKeyId: principal.apiKeyId },
          'mcp tool failed unexpectedly',
        );
      } else {
        logger.info(
          { code: platter.code, tool: tool.name, apiKeyId: principal.apiKeyId },
          'mcp tool refused',
        );
      }
      // An execution failure is a result, not a transport error: "this server is installing,
      // so it cannot start" is information the agent should read and act on.
      return { content: [{ type: 'text', text: describeError(platter) }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => ({
    resources: await listResources(contextFor(extra.signal)),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [...PLATTER_RESOURCE_TEMPLATES],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    try {
      return await readResource(request.params.uri, contextFor(extra.signal));
    } catch (error) {
      if (error instanceof McpError) throw error;
      // Resources have no `isError` channel, so a refusal has to be a JSON-RPC error. The
      // message is still Platter's own — `toPlatterError` keeps a driver or Prisma string
      // from reaching the client.
      const platter = toPlatterError(error);
      if (platter.code === 'internal_error') {
        logger.error({ err: error, uri: request.params.uri }, 'mcp resource read failed');
      }
      throw new McpError(ErrorCode.InternalError, describeError(platter));
    }
  });

  return server;
}
