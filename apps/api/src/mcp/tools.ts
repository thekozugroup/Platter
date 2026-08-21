import { connect, type Socket } from 'node:net';
import type { Server as ServerRecord } from '@prisma/client';
import { ErrorCode, McpError, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  ALLOWED_POWER_ACTIONS,
  LIMITS,
  PlatterError,
  canPerformPowerAction,
  consoleCommandRequestSchema,
  createServerRequestSchema,
  formatAddress,
  listServersQuerySchema,
  powerRequestSchema,
  serverSchema,
  serverSummarySchema,
  type Blueprint,
  type PowerAction,
} from '@platter/shared';
import {
  MINECRAFT_SERVER_TYPES,
  minecraftSupportsQuery,
  type MinecraftServerTypeInfo,
} from '../blueprints/index.js';
import { prisma } from '../db.js';
import { badRequest, invalidState, notFound } from '../lib/errors.js';
import { tryQueryBasic } from '../minecraft/query.js';
import { modSourceSchema } from '../mods/registry.js';
import type { DriverLogLine } from '../orchestration/driver.js';
import { getDriver } from '../orchestration/registry.js';
import { recordAudit } from '../services/audit.js';
import { getBlueprint, hasBlueprint, listBlueprintSummaries } from '../services/blueprints.js';
import {
  performPowerAction,
  sendCommand,
  deleteServer as removeServer,
} from '../services/lifecycle.js';
// Read-only halves of the mod service only. `applyResolution` and `removeInstalledMod` are
// deliberately absent — see the safety note below.
import {
  checkModUpdates,
  getServerMod,
  listInstalledMods,
  searchServerMods,
} from '../services/mods.js';
import {
  banPlayer,
  getPlayerCount,
  getPlayerRoster,
  kickPlayer,
  rconStatus,
  sendRconCommand,
  setWhitelisted,
} from '../services/players.js';
// `propose` only. `approve` is the install path and has no business being importable here.
import { getProposal, listProposals, propose } from '../services/proposals.js';
import {
  assertSendableCommand,
  createServer,
  getServerStats,
  listServers,
  loadServerDto,
  presentStatus,
} from '../services/servers.js';
import { METRIC_NAMES, RESOLUTIONS, querySeries, type Resolution } from '../services/timeseries.js';
import { authorizeServer, assertScope, type McpPrincipal } from './auth.js';

/**
 * Platter's tools, as an MCP client sees them.
 *
 * ## The safety property
 *
 * **No tool installs a mod.** `propose_mod` writes a pending record that a human approves in
 * the web UI, and this module has no import path to the installer at all: it pulls the
 * read-only half of `services/mods.ts` and only `propose` from `services/proposals.ts`.
 * `applyResolution`, `removeInstalledMod` and `approve` are the three symbols that could
 * put a file on a server's disk, and none of them appears anywhere below. That is checked by
 * a test, not left to reviewer memory. See docs/ARCHITECTURE.md §4.
 *
 * ## Shape
 *
 * Every tool declares a zod schema for both directions. Input is parsed before the handler
 * runs, so a handler never sees an unvalidated value; output is parsed after, so a drifted
 * handler fails here instead of shipping structured content that contradicts the schema an
 * agent was given. Both schemas are converted to JSON Schema once, at module load, which
 * also means a schema that cannot be represented breaks the build rather than the first
 * `tools/list` of the day.
 *
 * ## Bounds
 *
 * Everything is capped, in both directions. An agent's context window is the scarce resource
 * here: a `get_logs` that returned half a million lines would be a denial of service against
 * the client, so every list has a ceiling and every response says when it hit one.
 */

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Ceilings on everything that could otherwise grow with the size of the deployment. */
const CAPS = {
  servers: 50,
  logLines: 500,
  logLinesDefault: 200,
  diagnoseLines: 120,
  searchMatches: 50,
  contextLines: 3,
  modHits: 25,
  modVersions: 20,
  modGallery: 6,
  modDescription: 6000,
  modSummary: 400,
  installedMods: 200,
  proposals: 20,
  players: 200,
  metricPoints: 240,
  addressChecks: 6,
  gameVersions: 12,
  categories: 10,
  /** A filter pattern is user input compiled into a RegExp; long ones are refused outright. */
  filterPattern: 200,
  /**
   * Total console text in one response. The line count alone is not a bound: 500 lines at the
   * 2000-character ceiling is a megabyte, which would cost an agent more context than the
   * answer is worth. Whichever limit bites first, wins.
   */
  logBytes: 64 * 1024,
} as const;

/** The whole regex-filter pass over a bounded corpus, after which filtering gives up. */
const FILTER_BUDGET_MS = 250;

/** How long a log read is willing to sit on a follow stream waiting for the tail to arrive. */
const LOG_READ_DEADLINE_MS = 2500;

// ---------------------------------------------------------------------------
// Tool plumbing
// ---------------------------------------------------------------------------

export interface ToolContext {
  readonly principal: McpPrincipal;
  /** Written to audit rows: names the MCP client, the account and the revocable key. */
  readonly actorName: string;
  /** Fires when the client cancels the request or the transport goes away. */
  readonly signal: AbortSignal;
  readonly logger: FastifyBaseLogger;
}

/** The subset of JSON Schema the MCP `Tool` shape requires of a tool's schemas. */
export interface ToolJsonSchema {
  type: 'object';
  properties?: Record<string, object>;
  required?: string[];
  [key: string]: unknown;
}

export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ToolJsonSchema;
  readonly outputSchema: ToolJsonSchema;
  readonly annotations: ToolAnnotations;
  run(rawArgs: unknown, context: ToolContext): Promise<Record<string, unknown>>;
}

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output', label: string): ToolJsonSchema {
  const converted: Record<string, unknown> = z.toJSONSchema(schema, { io });
  // `$schema` is noise in a tool manifest: the MCP spec already fixes the dialect, and every
  // byte here is paid for in the client's context on every `tools/list`.
  delete converted['$schema'];
  if (converted['type'] !== 'object') {
    throw new Error(`MCP ${label} schema must be an object schema`);
  }
  return converted as ToolJsonSchema;
}

interface ToolSpec<Input extends z.ZodType, Output extends z.ZodType> {
  name: string;
  title: string;
  /** The agent's only documentation. Say what it does, what it does not, and what each argument means. */
  description: string;
  input: Input;
  output: Output;
  annotations: Omit<ToolAnnotations, 'title'>;
  handler: (args: z.output<Input>, context: ToolContext) => Promise<z.input<Output>>;
}

function issueSummary(error: z.ZodError<unknown>): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function defineTool<Input extends z.ZodType, Output extends z.ZodType>(
  spec: ToolSpec<Input, Output>,
): McpTool {
  const inputSchema = toJsonSchema(spec.input, 'input', `${spec.name} input`);
  const outputSchema = toJsonSchema(spec.output, 'output', `${spec.name} output`);

  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema,
    outputSchema,
    annotations: { title: spec.title, ...spec.annotations },
    async run(rawArgs, context) {
      // Bad arguments are a protocol error, not a tool result: the call never happened, and
      // an agent that gets `isError` text back cannot tell that apart from a real failure.
      const parsed = spec.input.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for ${spec.name}: ${issueSummary(parsed.error)}`,
        );
      }
      const result = await spec.handler(parsed.data, context);
      return spec.output.parse(result) as Record<string, unknown>;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared argument pieces
// ---------------------------------------------------------------------------

/**
 * Deliberately looser than a real id's shape, mirroring the HTTP routes: a malformed id must
 * come back as the same "does not exist" a real-but-invisible one does, so probing tells an
 * agent nothing about servers it may not see.
 */
const serverIdArg = z
  .string()
  .min(1)
  .max(64)
  .describe('Platter server id (e.g. srv_01J2…). Use list_servers to find one.');

const confirmArg = z
  .boolean()
  .default(false)
  .describe(
    'Must be true to actually perform this action. Called with false, the tool explains what would happen and changes nothing.',
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): { text: string; truncated: boolean } {
  return value.length <= max
    ? { text: value, truncated: false }
    : { text: `${value.slice(0, max)}…`, truncated: true };
}

async function findBlueprint(key: string): Promise<Blueprint | null> {
  return hasBlueprint(key) ? getBlueprint(key) : null;
}

export interface LogRead {
  lines: DriverLogLine[];
  /** True when the tail did not fill before the read deadline — normal for a quiet server. */
  timedOut: boolean;
  /** Null when the runtime had logs to give; a sentence when it did not. */
  unavailable: string | null;
}

/**
 * Reads the tail of a server's console.
 *
 * The driver's log stream follows forever by design — it is the same call the live console
 * uses — so this owns an AbortController and stops on whichever comes first: enough lines,
 * a deadline, or the client cancelling. Without the deadline a quiet running server would
 * hold the request open until the transport gave up; without the abort, every call would
 * leak a follow stream on the Docker daemon.
 *
 * The in-memory `LogHub` is deliberately not used: it only holds lines while something is
 * subscribed, and attaching it here would open a stream with no subscriber to ever close it.
 */
export async function readRecentLines(
  server: ServerRecord,
  limit: number,
  signal: AbortSignal,
): Promise<LogRead> {
  const lines: DriverLogLine[] = [];
  let timedOut = false;

  let driver;
  try {
    driver = await getDriver(server.nodeId);
  } catch (error) {
    return {
      lines,
      timedOut,
      unavailable: describeFailure(error, 'The node could not be reached.'),
    };
  }

  const controller = new AbortController();
  const onCancel = (): void => {
    controller.abort();
  };
  signal.addEventListener('abort', onCancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LOG_READ_DEADLINE_MS);

  try {
    for await (const line of driver.streamLogs(server.id, {
      tail: limit,
      signal: controller.signal,
    })) {
      lines.push(line);
      if (lines.length >= limit) break;
    }
  } catch (error) {
    if (error instanceof PlatterError && error.code === 'not_found') {
      return {
        lines,
        timedOut,
        unavailable: 'This server has no container yet, so there is nothing to read.',
      };
    }
    return {
      lines,
      timedOut,
      unavailable: describeFailure(error, 'The console could not be read.'),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCancel);
    // Also fires on the `break` above: leaving the follow stream open would hold a
    // connection to the daemon for the life of the process.
    controller.abort();
  }

  return { lines, timedOut, unavailable: null };
}

function describeFailure(error: unknown, fallback: string): string {
  return error instanceof PlatterError ? error.message : fallback;
}

export const logEntrySchema = z.object({
  timestamp: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  content: z.string(),
});

/**
 * Trims a list of log-bearing entries to a byte budget, keeping the **most recent**.
 *
 * The tail is the part that explains anything, so the drop happens at the front. The count of
 * dropped entries is returned rather than swallowed: a response that quietly lost its first
 * forty lines is worse than one that says it did.
 */
export function withinLogBudget<T extends { content: string }>(
  entries: readonly T[],
  budget = CAPS.logBytes,
): { kept: T[]; dropped: number } {
  let used = 0;
  let start = entries.length;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    used += entry.content.length + 64; // + a rough allowance for the timestamp and stream tag
    if (used > budget) break;
    start = index;
  }
  return { kept: entries.slice(start), dropped: start };
}

export function toLogEntries(lines: readonly DriverLogLine[]): z.infer<typeof logEntrySchema>[] {
  return lines.map((line) => ({
    timestamp: line.timestamp.toISOString(),
    stream: line.stream,
    // The console's own per-line ceiling: one runaway line must not swallow the whole budget.
    content: truncate(line.content, LIMITS.maxConsoleLineLength).text,
  }));
}

/**
 * Compiles a caller-supplied filter.
 *
 * The pattern is authored by the holder of an API key, which is the same trust level a
 * blueprint's own patterns carry (`services/servers.ts#compilePattern`). It is length-capped,
 * and every use of it runs against a corpus that is already bounded to `CAPS.logLines`, under
 * a wall-clock budget — so a catastrophically backtracking pattern costs a slow response
 * rather than a wedged process.
 */
function compileFilter(pattern: string, caseSensitive: boolean): RegExp {
  if (pattern.length > CAPS.filterPattern) {
    throw badRequest(`Keep the pattern under ${CAPS.filterPattern} characters.`);
  }
  try {
    return new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch (error) {
    throw badRequest(
      `That is not a valid regular expression: ${error instanceof Error ? error.message : 'unparsable'}`,
    );
  }
}

interface FilterOutcome<T> {
  kept: T[];
  /** True when the budget ran out and the tail of the corpus was never examined. */
  gaveUp: boolean;
}

function filterWithBudget<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): FilterOutcome<T> {
  const deadline = Date.now() + FILTER_BUDGET_MS;
  const kept: T[] = [];
  for (let index = 0; index < items.length; index += 1) {
    // Checked every 25 items rather than every item: `Date.now()` is not free, and 25 lines
    // of a bounded length cannot overrun the budget by anything a caller would notice.
    if (index % 25 === 0 && Date.now() > deadline) return { kept, gaveUp: true };
    const item = items[index];
    if (item !== undefined && predicate(item)) kept.push(item);
  }
  return { kept, gaveUp: false };
}

/** Audit metadata every MCP-initiated write carries, so an entry is traceable to a key. */
function auditVia(context: ToolContext, tool: string): Record<string, unknown> {
  return {
    via: 'mcp',
    tool,
    apiKeyId: context.principal.apiKeyId,
    apiKeyPrefix: context.principal.apiKeyPrefix,
  };
}

async function auditMcp(
  context: ToolContext,
  input: {
    action: 'server.created' | 'server.deleted' | 'server.power' | 'server.command';
    server: { id: string; name: string };
    tool: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await recordAudit({
    action: input.action,
    targetType: 'server',
    targetId: input.server.id,
    targetName: input.server.name,
    actorId: context.principal.user.id,
    actorName: context.actorName,
    metadata: { ...auditVia(context, input.tool), ...input.metadata },
    ip: context.principal.ip,
    userAgent: context.principal.userAgent,
    logger: context.logger,
  });
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const listServersTool = defineTool({
  name: 'list_servers',
  title: 'List game servers',
  description:
    'Lists the game servers this API key can see, newest first. Members see the servers they own or ' +
    'have been invited to; admins see all of them. Returns one page at a time — read `total` and ' +
    '`totalPages` and pass `page` to walk further. Does not start, stop or change anything.\n' +
    'Arguments: `status` filters to one lifecycle state; `blueprintKey` filters to one game ' +
    '(e.g. minecraft-java); `search` matches name, blueprint key or exact id; `page` is 1-based; ' +
    `\`perPage\` is capped at ${CAPS.servers}.`,
  input: z.object({
    status: listServersQuerySchema.shape.status,
    blueprintKey: z.string().max(64).optional(),
    search: z.string().max(120).optional(),
    page: z.number().int().min(1).default(1),
    perPage: z.number().int().min(1).max(CAPS.servers).default(25),
  }),
  output: z.object({
    servers: z.array(serverSummarySchema),
    page: z.number().int(),
    perPage: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    assertScope(context.principal, 'server.view');
    // Parsed through the shared query schema so this path and the HTTP one cannot drift.
    const query = listServersQuerySchema.parse({
      page: args.page,
      perPage: args.perPage,
      ...(args.status ? { status: args.status } : {}),
      ...(args.blueprintKey ? { blueprintKey: args.blueprintKey } : {}),
      ...(args.search ? { search: args.search } : {}),
    });
    const page = await listServers(query, context.principal.user);
    return {
      servers: page.data,
      page: page.meta.page,
      perPage: page.meta.perPage,
      total: page.meta.total,
      totalPages: page.meta.totalPages,
    };
  },
});

const getServerTool = defineTool({
  name: 'get_server',
  title: 'Get one server',
  description:
    'Everything Platter stores about one server: lifecycle status, resource limits, port allocations, ' +
    'blueprint variables, and the timestamps of the last install, start and crash. Read-only.\n' +
    'Blueprint variables declared as passwords (RCON passwords, admin passwords) come back as ' +
    '`[redacted]`; their keys are listed in `redactedVariables` so you know they are set. ' +
    'For live CPU/memory use get_server_status; for the connection string use get_server_address.',
  input: z.object({ serverId: serverIdArg }),
  output: z.object({
    server: serverSchema,
    redactedVariables: z.array(z.string()),
    primaryAddress: z.string().nullable(),
    blueprint: z
      .object({
        key: z.string(),
        name: z.string(),
        game: z.string(),
        features: z.object({
          console: z.boolean(),
          rcon: z.boolean(),
          mods: z.boolean(),
          worldUpload: z.boolean(),
          playerList: z.boolean(),
        }),
      })
      .nullable(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const row = await authorizeServer(context.principal, args.serverId, 'server.view');
    // Redaction and the connect string are both applied by the DTO itself now, so every
    // reader — REST and MCP alike — gets the same answer without repeating the rule here.
    const dto = await loadServerDto(row.id, context.logger);
    const blueprint = await findBlueprint(row.blueprintKey);

    return {
      server: dto,
      redactedVariables: dto.redactedVariables,
      primaryAddress: dto.connectString,
      blueprint: blueprint
        ? {
            key: blueprint.key,
            name: blueprint.name,
            game: blueprint.game,
            features: blueprint.features,
          }
        : null,
    };
  },
});

const listBlueprintsTool = defineTool({
  name: 'list_blueprints',
  title: 'List blueprints',
  description:
    'Lists the game blueprints ("platters") this Platter install can provision. A blueprint is the ' +
    'recipe for one game: which community container image to run, what an operator may configure, ' +
    'and how much memory it needs. `key` is what create_server takes as `blueprintKey`. Read-only.\n' +
    'Arguments: `category` narrows to one genre; `search` matches name, game or key; `feature` keeps ' +
    'only blueprints with that capability (`mods` is the mod-browser flag — today only minecraft-java). ' +
    'Call get_blueprint for the variables you can set, and for the Minecraft server-type matrix.',
  input: z.object({
    category: z
      .enum(['survival', 'sandbox', 'shooter', 'simulation', 'strategy', 'roleplay', 'other'])
      .optional(),
    search: z.string().max(80).optional(),
    feature: z.enum(['console', 'rcon', 'mods', 'worldUpload', 'playerList']).optional(),
  }),
  output: z.object({
    blueprints: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        game: z.string(),
        summary: z.string(),
        category: z.string(),
        minMemoryMb: z.number().int(),
        recommendedMemoryMb: z.number().int(),
        minDiskMb: z.number().int(),
        features: z.object({
          console: z.boolean(),
          rcon: z.boolean(),
          mods: z.boolean(),
          worldUpload: z.boolean(),
          playerList: z.boolean(),
        }),
      }),
    ),
    total: z.number().int(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // No scope check, matching `routes/blueprints.ts`: the catalogue is what this build can
  // install, not information about anyone's servers. Gating it would only stop an agent
  // discovering what it may ask for.
  handler: async (args) => {
    const summaries = listBlueprintSummaries({
      ...(args.category ? { category: args.category } : {}),
      ...(args.search ? { search: args.search } : {}),
      ...(args.feature ? { feature: args.feature } : {}),
    });
    return {
      blueprints: summaries.map((summary) => ({
        key: summary.key,
        name: summary.name,
        game: summary.game,
        summary: summary.summary,
        category: summary.category,
        minMemoryMb: summary.minMemoryMb,
        recommendedMemoryMb: summary.recommendedMemoryMb,
        minDiskMb: summary.minDiskMb,
        features: summary.features,
      })),
      total: summaries.length,
    };
  },
});

const minecraftServerTypeSchema = z.object({
  type: z.string(),
  label: z.string(),
  family: z.string(),
  modTarget: z.enum(['mods', 'plugins']).nullable(),
  acceptsMods: z.boolean(),
  acceptsPlugins: z.boolean(),
  rcon: z.boolean(),
  query: z.boolean(),
  variables: z.array(z.string()),
  note: z.string(),
});

function toMinecraftType(info: MinecraftServerTypeInfo): z.infer<typeof minecraftServerTypeSchema> {
  return {
    type: info.type,
    label: info.label,
    family: info.family,
    modTarget: info.modTarget,
    acceptsMods: info.acceptsMods,
    acceptsPlugins: info.acceptsPlugins,
    rcon: info.rcon,
    query: info.query,
    variables: [...info.variables],
    note: info.note,
  };
}

const getBlueprintTool = defineTool({
  name: 'get_blueprint',
  title: 'Get one blueprint',
  description:
    'The full recipe for one game: image, memory and disk minimums, ports, and every variable ' +
    'create_server accepts, with its type, default and allowed values. Read-only.\n' +
    'For `minecraft-java` the response also carries `minecraftServerTypes`: the complete matrix of ' +
    'values the TYPE variable accepts (VANILLA, PAPER, FABRIC, FORGE, PURPUR, …), each saying whether ' +
    'it takes mods, plugins or both, and whether it speaks RCON and the query protocol. Read that ' +
    'before choosing — Paper takes Bukkit plugins and not Fabric mods, and the two are not interchangeable.\n' +
    "Variables the blueprint marks hidden are omitted: they are the blueprint's own and cannot be set.",
  input: z.object({
    key: z.string().min(1).max(64).describe('Blueprint key, e.g. minecraft-java.'),
  }),
  output: z.object({
    blueprint: z.object({
      key: z.string(),
      name: z.string(),
      game: z.string(),
      summary: z.string(),
      description: z.string(),
      category: z.string(),
      image: z.string(),
      minMemoryMb: z.number().int(),
      recommendedMemoryMb: z.number().int(),
      minDiskMb: z.number().int(),
      ports: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          containerPort: z.number().int(),
          protocol: z.enum(['tcp', 'udp']),
          primary: z.boolean(),
        }),
      ),
      variables: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          description: z.string(),
          type: z.enum(['string', 'number', 'boolean', 'enum', 'password']),
          default: z.union([z.string(), z.number(), z.boolean()]).nullable(),
          required: z.boolean(),
          options: z.array(z.object({ value: z.string(), label: z.string() })),
          min: z.number().nullable(),
          max: z.number().nullable(),
          advanced: z.boolean(),
        }),
      ),
      features: z.object({
        console: z.boolean(),
        rcon: z.boolean(),
        mods: z.boolean(),
        worldUpload: z.boolean(),
        playerList: z.boolean(),
      }),
      stopStrategy: z.enum(['command', 'signal']),
      stopTimeoutSeconds: z.number().int(),
      docsUrl: z.string().nullable(),
    }),
    minecraftServerTypes: z.array(minecraftServerTypeSchema).nullable(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => {
    const blueprint = getBlueprint(args.key);
    return {
      blueprint: {
        key: blueprint.key,
        name: blueprint.name,
        game: blueprint.game,
        summary: blueprint.summary,
        description: blueprint.description,
        category: blueprint.category,
        image: blueprint.image,
        minMemoryMb: blueprint.minMemoryMb,
        recommendedMemoryMb: blueprint.recommendedMemoryMb,
        minDiskMb: blueprint.minDiskMb,
        ports: blueprint.ports.map((port) => ({
          name: port.name,
          label: port.label,
          containerPort: port.containerPort,
          protocol: port.protocol,
          primary: port.primary,
        })),
        variables: blueprint.variables
          .filter((variable) => !variable.hidden)
          .map((variable) => ({
            key: variable.key,
            label: variable.label,
            description: variable.description,
            type: variable.type,
            default: variable.default,
            required: variable.required,
            options: variable.options,
            min: variable.min,
            max: variable.max,
            advanced: variable.advanced,
          })),
        features: blueprint.features,
        stopStrategy: blueprint.stop.strategy,
        stopTimeoutSeconds: blueprint.stop.timeoutSeconds,
        docsUrl: blueprint.docsUrl,
      },
      minecraftServerTypes:
        blueprint.key === 'minecraft-java' ? MINECRAFT_SERVER_TYPES.map(toMinecraftType) : null,
    };
  },
});

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

const createServerTool = defineTool({
  name: 'create_server',
  title: 'Create a game server',
  description:
    'Provisions a new game server from a blueprint. Goes through exactly the service the web UI ' +
    'uses — the same validation, the same node placement, the same port allocation — so there is no ' +
    'agent-only shortcut and no way to exceed a limit a human could not.\n' +
    'Arguments mirror the HTTP create request. `blueprintKey` is required (see list_blueprints). ' +
    '`variables` sets blueprint variables by key; unknown keys are dropped and invalid values are ' +
    'refused with a per-field message. `limits` overrides memory/disk/CPU — omit it to take the ' +
    "blueprint's recommendation, which is usually right. `ports` pins specific host ports; omit it " +
    "and Platter allocates from the node's range.\n" +
    'With `startOnCreate` true (the default) the install begins immediately in the background: the ' +
    'call returns as soon as the record exists, with status `provisioning`. Poll get_server_status — ' +
    'a first install downloads the game and can take several minutes. This tool does not wait for it.',
  input: createServerRequestSchema,
  output: z.object({
    serverId: z.string(),
    name: z.string(),
    blueprintKey: z.string(),
    nodeId: z.string(),
    status: z.string(),
    limits: z.object({
      memoryMb: z.number().int(),
      diskMb: z.number().int(),
      cpuCores: z.number(),
    }),
    allocations: z.array(
      z.object({
        name: z.string(),
        hostPort: z.number().int(),
        protocol: z.enum(['tcp', 'udp']),
        primary: z.boolean(),
      }),
    ),
    installing: z.boolean(),
    nextStep: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    assertScope(context.principal, 'server.create');
    const server = await createServer(args, context.principal.user, context.logger);

    await auditMcp(context, {
      action: 'server.created',
      server,
      tool: 'create_server',
      metadata: {
        blueprintKey: server.blueprintKey,
        nodeId: server.nodeId,
        memoryMb: server.limits.memoryMb,
        startOnCreate: args.startOnCreate,
      },
    });

    return {
      serverId: server.id,
      name: server.name,
      blueprintKey: server.blueprintKey,
      nodeId: server.nodeId,
      status: server.status,
      limits: {
        memoryMb: server.limits.memoryMb,
        diskMb: server.limits.diskMb,
        cpuCores: server.limits.cpuCores,
      },
      allocations: server.allocations.map((allocation) => ({
        name: allocation.name,
        hostPort: allocation.hostPort,
        protocol: allocation.protocol,
        primary: allocation.primary,
      })),
      installing: args.startOnCreate,
      nextStep: args.startOnCreate
        ? 'The install is running in the background. Poll get_server_status until it reports running or install_failed.'
        : 'Nothing is installed yet. Call power_server with action "start" to install and boot it.',
    };
  },
});

const deleteServerTool = defineTool({
  name: 'delete_server',
  title: 'Delete a server',
  description:
    'Permanently deletes a server: the container is removed, the data directory — worlds, saves, ' +
    'configuration, installed mods — is destroyed, and its ports are returned to the pool. ' +
    'This cannot be undone and does not create a backup first.\n' +
    'Two confirmations are required and both must be supplied in the same call: `confirm` must be ' +
    "true, and `confirmServerName` must exactly match the server's current name. Called without " +
    'them, the tool reports what would be destroyed and deletes nothing. Ask the human before ' +
    'calling this with confirmation.',
  input: z.object({
    serverId: serverIdArg,
    confirm: confirmArg,
    confirmServerName: z
      .string()
      .max(LIMITS.serverNameMax)
      .optional()
      .describe("The server's exact current name. Guards against deleting the wrong server."),
  }),
  output: z.object({
    deleted: z.boolean(),
    serverId: z.string(),
    name: z.string(),
    status: z.string(),
    message: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.delete');
    const status = presentStatus(server);

    if (!args.confirm || args.confirmServerName !== server.name) {
      return {
        deleted: false,
        serverId: server.id,
        name: server.name,
        status,
        message:
          `Nothing was deleted. Deleting "${server.name}" destroys its container and its entire data ` +
          `directory, including worlds and saves, and cannot be undone. To proceed, call delete_server ` +
          `again with confirm: true and confirmServerName: ${JSON.stringify(server.name)}.`,
      };
    }

    await removeServer(server.id, context.principal.user.id);
    await auditMcp(context, {
      action: 'server.deleted',
      server,
      tool: 'delete_server',
      metadata: { blueprintKey: server.blueprintKey, statusBefore: status },
    });

    return {
      deleted: true,
      serverId: server.id,
      name: server.name,
      status: 'deleted',
      message: `${server.name} and its data directory were deleted.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Each power action is governed by the permission a human needs for the same button. */
const POWER_PERMISSION = {
  start: 'power.start',
  stop: 'power.stop',
  restart: 'power.restart',
  // A kill is a stop that skips the graceful path; it is not a fourth kind of authority.
  kill: 'power.stop',
} as const satisfies Record<PowerAction, 'power.start' | 'power.stop' | 'power.restart'>;

const powerServerTool = defineTool({
  name: 'power_server',
  title: 'Start, stop, restart or kill a server',
  description:
    "Changes a server's power state. `start` boots it (installing first if it never has); `stop` " +
    "sends the blueprint's graceful shutdown and waits for the process to exit; `restart` is a stop " +
    'followed by a start; `kill` is an immediate SIGKILL that does not let the game save.\n' +
    'stop, restart and kill disconnect every player and require `confirm: true`. Called without it, ' +
    'the tool reports the current state and does nothing. `force: true` skips the graceful stop ' +
    'command and goes straight to the signal — it risks world corruption on games that save on exit.\n' +
    'Only the transitions the lifecycle allows are accepted: you cannot start a server that is ' +
    'installing, or stop one that is already offline. A refusal names the actions that are legal ' +
    'from the current status. stop and restart block until the process has actually exited, which ' +
    "is up to the blueprint's grace period; start returns once the container is up, before the " +
    'game has finished booting — poll get_server_status for that.',
  input: z.object({
    serverId: serverIdArg,
    action: powerRequestSchema.shape.action.describe('start | stop | restart | kill'),
    force: z
      .boolean()
      .default(false)
      .describe(
        'Skip the graceful stop command and signal the process directly. Ignored for start.',
      ),
    confirm: confirmArg,
  }),
  output: z.object({
    applied: z.boolean(),
    serverId: z.string(),
    action: z.string(),
    statusBefore: z.string(),
    statusAfter: z.string(),
    allowedActions: z.array(z.string()),
    message: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    // Parsed through the shared request schema, so this tool and the HTTP endpoint accept
    // exactly the same set of actions.
    const request = powerRequestSchema.parse({ action: args.action, force: args.force });
    const server = await authorizeServer(
      context.principal,
      args.serverId,
      POWER_PERMISSION[request.action],
    );
    const statusBefore = presentStatus(server);
    const allowedActions = [...ALLOWED_POWER_ACTIONS[statusBefore]];

    if (!canPerformPowerAction(statusBefore, request.action)) {
      throw invalidState(
        `${server.name} is ${statusBefore}, so it cannot be ${request.action}ed. ` +
          (allowedActions.length > 0
            ? `Allowed right now: ${allowedActions.join(', ')}.`
            : 'No power action is available from this state.'),
      );
    }

    const interrupts = request.action !== 'start';
    if (interrupts && !args.confirm) {
      return {
        applied: false,
        serverId: server.id,
        action: request.action,
        statusBefore,
        statusAfter: statusBefore,
        allowedActions,
        message:
          `Nothing changed. ${request.action} disconnects everyone currently playing on ` +
          `"${server.name}"${request.action === 'kill' ? ' and does not let the game save first' : ''}. ` +
          `Call again with confirm: true to proceed.`,
      };
    }

    await performPowerAction(server.id, request.action, context.principal.user.id, {
      force: request.force,
    });

    const after = await prisma.server.findUnique({
      where: { id: server.id },
      select: { status: true, suspended: true },
    });
    const statusAfter = after ? presentStatus(after) : 'offline';

    await auditMcp(context, {
      action: 'server.power',
      server,
      tool: 'power_server',
      metadata: { powerAction: request.action, force: request.force, statusBefore, statusAfter },
    });

    return {
      applied: true,
      serverId: server.id,
      action: request.action,
      statusBefore,
      statusAfter,
      allowedActions: [...ALLOWED_POWER_ACTIONS[statusAfter]],
      message: `${server.name}: ${statusBefore} → ${statusAfter}.`,
    };
  },
});

const sendConsoleCommandTool = defineTool({
  name: 'send_console_command',
  title: 'Send a console command',
  description:
    'Sends one command to a running server, exactly as typing it into the web console would. ' +
    'The server must be running.\n' +
    "When the game speaks RCON and Platter can reach it, the command goes over RCON and the game's " +
    "reply comes back in `output`. Otherwise it is written to the container's stdin, which is " +
    'fire-and-forget: `output` is null and the result only shows up in the log — read it with ' +
    'get_logs. `delivery` says which path was used.\n' +
    'A command cannot contain a newline: stdin is line-oriented, so a second line would be a second ' +
    'command that nothing authorised and nothing audited. Every call is written to the audit log ' +
    "with the calling agent's identity. For kicks, bans and whitelisting prefer the dedicated " +
    'tools — they validate the player name and report refusals properly.',
  input: z.object({
    serverId: serverIdArg,
    command: consoleCommandRequestSchema.shape.command.describe(
      'The command, without a leading slash and without newlines (e.g. "say hello", "time set day").',
    ),
  }),
  output: z.object({
    serverId: z.string(),
    command: z.string(),
    delivery: z.enum(['rcon', 'stdin']),
    output: z.string().nullable(),
    note: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'console.write');
    const { command } = consoleCommandRequestSchema.parse({ command: args.command });
    assertSendableCommand(server, command);

    const blueprint = await findBlueprint(server.blueprintKey);
    // RCON is preferred purely because it answers. An agent that cannot see the result of
    // its own command is reduced to guessing, which is how it ends up sending it twice.
    const useRcon = blueprint?.features.rcon === true && (await rconStatus(server.id)).available;

    let output: string | null = null;
    if (useRcon) {
      output = await sendRconCommand(server.id, command, { logger: context.logger });
    } else {
      await sendCommand(server.id, command, context.principal.user.id);
    }

    await auditMcp(context, {
      action: 'server.command',
      server,
      tool: 'send_console_command',
      metadata: { command, delivery: useRcon ? 'rcon' : 'stdin' },
    });

    return {
      serverId: server.id,
      command,
      delivery: useRcon ? ('rcon' as const) : ('stdin' as const),
      output: output === null ? null : truncate(output, LIMITS.maxConsoleLineLength * 4).text,
      note: useRcon
        ? "The game's reply is in `output`."
        : 'Written to stdin. This game returns nothing directly — check get_logs for the result.',
    };
  },
});

const getServerStatusTool = defineTool({
  name: 'get_server_status',
  title: 'Get live server status',
  description:
    'A point-in-time reading of one running server: lifecycle status, uptime, CPU percent, memory ' +
    'and disk bytes, network counters, and the player count when the game exposes one. Read-only ' +
    'and cheap enough to poll while waiting for an install or a boot to finish.\n' +
    '`playersOnline` is null when the count could not be read — the server is off, or the game has ' +
    'no way to report it. Null is not zero. For history rather than a single sample use get_metrics.',
  input: z.object({ serverId: serverIdArg }),
  output: z.object({
    serverId: z.string(),
    status: z.string(),
    uptimeSeconds: z.number().int(),
    cpuPercent: z.number(),
    memoryBytes: z.number(),
    memoryLimitBytes: z.number(),
    diskBytes: z.number(),
    networkRxBytes: z.number(),
    networkTxBytes: z.number(),
    playersOnline: z.number().int().nullable(),
    playersMax: z.number().int().nullable(),
    lastExitCode: z.number().int().nullable(),
    lastCrashAt: z.string().nullable(),
    sampledAt: z.string(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.view');
    const stats = await getServerStats(server);

    let playersOnline = stats.playersOnline;
    let playersMax = stats.playersMax;
    const blueprint = await findBlueprint(server.blueprintKey);
    if (blueprint?.features.playerList === true && stats.status === 'running') {
      try {
        const count = await getPlayerCount(server.id);
        if (count) {
          playersOnline = count.online;
          playersMax = count.max;
        }
      } catch (error) {
        // A game that will not answer a player query is not a failed status call.
        context.logger.debug({ err: error, serverId: server.id }, 'mcp player count unavailable');
      }
    }

    return {
      serverId: server.id,
      status: stats.status,
      uptimeSeconds: stats.uptimeSeconds,
      cpuPercent: stats.cpuPercent,
      memoryBytes: stats.memoryBytes,
      memoryLimitBytes: stats.memoryLimitBytes,
      diskBytes: stats.diskBytes,
      networkRxBytes: stats.networkRxBytes,
      networkTxBytes: stats.networkTxBytes,
      playersOnline,
      playersMax,
      lastExitCode: server.lastExitCode,
      lastCrashAt: server.lastCrashAt?.toISOString() ?? null,
      sampledAt: stats.sampledAt,
    };
  },
});

// ---------------------------------------------------------------------------
// Debugging
// ---------------------------------------------------------------------------

const getLogsTool = defineTool({
  name: 'get_logs',
  title: 'Read recent console output',
  description:
    `Returns the tail of a server's console, oldest line first. Hard cap ${CAPS.logLines} lines per ` +
    `call (default ${CAPS.logLinesDefault}); ask for more and you get the cap, with \`capped\` set. ` +
    'Individual lines are truncated too, so one runaway line cannot swallow the response.\n' +
    'Arguments: `lines` is how many to read; `stream` keeps only stdout or only stderr; `filter` is ' +
    'a JavaScript regular expression applied to the line text after reading, so it narrows the ' +
    `${CAPS.logLines}-line window rather than searching further back. To search rather than tail, use ` +
    'search_logs.\n' +
    'Reads only — nothing is sent to the server. A server with no container yet returns no lines and ' +
    'says so in `unavailable`.',
  input: z.object({
    serverId: serverIdArg,
    lines: z.number().int().min(1).max(CAPS.logLines).default(CAPS.logLinesDefault),
    stream: z.enum(['all', 'stdout', 'stderr']).default('all'),
    filter: z.string().max(CAPS.filterPattern).optional(),
    caseSensitive: z.boolean().default(false),
  }),
  output: z.object({
    serverId: z.string(),
    status: z.string(),
    lines: z.array(logEntrySchema),
    returned: z.number().int(),
    requested: z.number().int(),
    capped: z.boolean(),
    filterGaveUp: z.boolean(),
    unavailable: z.string().nullable(),
    note: z.string(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'console.read');
    const limit = Math.min(args.lines, CAPS.logLines);
    const read = await readRecentLines(server, limit, context.signal);

    let entries = toLogEntries(read.lines);
    if (args.stream !== 'all') {
      entries = entries.filter((entry) => entry.stream === args.stream);
    }

    let filterGaveUp = false;
    if (args.filter !== undefined) {
      const pattern = compileFilter(args.filter, args.caseSensitive);
      const outcome = filterWithBudget(entries, (entry) => pattern.test(entry.content));
      entries = outcome.kept;
      filterGaveUp = outcome.gaveUp;
    }

    const budgeted = withinLogBudget(entries);

    const notes: string[] = [];
    if (args.lines > CAPS.logLines) notes.push(`Capped at ${CAPS.logLines} lines.`);
    if (read.timedOut && read.lines.length < limit) {
      notes.push(
        'The console had fewer lines than requested, or was still quiet when the read ended.',
      );
    }
    if (filterGaveUp) notes.push('The filter ran out of time; later lines were not examined.');
    if (budgeted.dropped > 0) {
      notes.push(
        `${budgeted.dropped} older lines were dropped to stay within the ${CAPS.logBytes / 1024} KB response budget.`,
      );
    }

    return {
      serverId: server.id,
      status: presentStatus(server),
      lines: budgeted.kept,
      returned: budgeted.kept.length,
      requested: args.lines,
      capped: args.lines > CAPS.logLines || budgeted.dropped > 0,
      filterGaveUp,
      unavailable: read.unavailable,
      note: notes.length > 0 ? notes.join(' ') : 'Complete for the window read.',
    };
  },
});

const searchLogsTool = defineTool({
  name: 'search_logs',
  title: 'Search recent console output',
  description:
    `Searches the last ${CAPS.logLines} console lines for a JavaScript regular expression and returns ` +
    'the matches, each with its position in the window and optional surrounding lines. Use this to ' +
    'find a stack trace, a specific player name, or the line a crash pattern fired on.\n' +
    'Arguments: `pattern` is required and is a regular expression, not a plain substring — escape ' +
    'regex metacharacters if you mean them literally. `window` is how many recent lines to scan. ' +
    `\`maxMatches\` caps the returned matches at ${CAPS.searchMatches}; \`contextLines\` adds up to ` +
    `${CAPS.contextLines} lines either side of each hit. \`matched\` is the true count within the ` +
    'window even when the returned list was truncated.\n' +
    'This does not search a log archive — Platter keeps no log history beyond what the container ' +
    'runtime still holds. Read-only.',
  input: z.object({
    serverId: serverIdArg,
    pattern: z.string().min(1).max(CAPS.filterPattern),
    window: z.number().int().min(1).max(CAPS.logLines).default(CAPS.logLines),
    maxMatches: z.number().int().min(1).max(CAPS.searchMatches).default(20),
    contextLines: z.number().int().min(0).max(CAPS.contextLines).default(0),
    caseSensitive: z.boolean().default(false),
  }),
  output: z.object({
    serverId: z.string(),
    pattern: z.string(),
    scanned: z.number().int(),
    matched: z.number().int(),
    truncated: z.boolean(),
    searchGaveUp: z.boolean(),
    matches: z.array(
      z.object({
        index: z.number().int(),
        timestamp: z.string(),
        stream: z.enum(['stdout', 'stderr']),
        content: z.string(),
        context: z.array(logEntrySchema),
      }),
    ),
    unavailable: z.string().nullable(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'console.read');
    const read = await readRecentLines(
      server,
      Math.min(args.window, CAPS.logLines),
      context.signal,
    );
    const entries = toLogEntries(read.lines);
    const pattern = compileFilter(args.pattern, args.caseSensitive);

    const indexed = entries.map((entry, index) => ({ entry, index }));
    const outcome = filterWithBudget(indexed, (item) => pattern.test(item.entry.content));

    // Context multiplies the payload by up to seven, so the byte budget is applied to the
    // matches themselves — newest kept, oldest dropped — before the context is attached.
    const budgeted = withinLogBudget(
      outcome.kept
        .slice(0, args.maxMatches)
        .map((item) => ({ ...item, content: item.entry.content })),
      Math.floor(CAPS.logBytes / (1 + 2 * args.contextLines)),
    );

    const matches = budgeted.kept.map((item) => ({
      index: item.index,
      timestamp: item.entry.timestamp,
      stream: item.entry.stream,
      content: item.entry.content,
      context:
        args.contextLines === 0
          ? []
          : entries.slice(
              Math.max(0, item.index - args.contextLines),
              Math.min(entries.length, item.index + args.contextLines + 1),
            ),
    }));

    return {
      serverId: server.id,
      pattern: args.pattern,
      scanned: entries.length,
      matched: outcome.kept.length,
      truncated: outcome.kept.length > matches.length,
      searchGaveUp: outcome.gaveUp,
      matches,
      unavailable: read.unavailable,
    };
  },
});

const RANGE_MS = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
} as const;

/**
 * Full-resolution samples are only retained for a few hours (see `services/timeseries.ts`),
 * so a wide window asked for at `raw` would come back empty. This mirrors the same choice
 * `routes/metrics.ts` makes; it is repeated rather than shared because that module owns its
 * copy and neither should reach into the other.
 */
function pickResolution(spanMs: number): Resolution {
  if (spanMs <= 3 * 3_600_000) return 'raw';
  if (spanMs <= 2 * 86_400_000) return '1m';
  return '5m';
}

const getMetricsTool = defineTool({
  name: 'get_metrics',
  title: 'Get resource-usage history',
  description:
    'Resource-usage history for one server, as a time series plus a summary. Metrics: `cpu` (percent), ' +
    '`memory`, `disk`, `networkRx`, `networkTx` (bytes; the network ones are cumulative counters, so ' +
    'differences between points are throughput), `players`, `tps`.\n' +
    `Returns at most ${CAPS.metricPoints} points — the most recent ones — with \`summary\` computed ` +
    'over the whole requested window, so a truncated series still gives you the right min, max and ' +
    'average. Older windows are served from coarser rollups; `resolution` says which.\n' +
    'An empty `points` array means no data yet, not a failure: `players` and `tps` are empty for games ' +
    'that expose no way to read them, and every series is empty for a server that has never run.',
  input: z.object({
    serverId: serverIdArg,
    metric: z.enum(METRIC_NAMES),
    range: z.enum(['1h', '6h', '24h', '7d', '30d']).default('1h'),
    resolution: z.enum(RESOLUTIONS).optional(),
  }),
  output: z.object({
    serverId: z.string(),
    metric: z.string(),
    resolution: z.string(),
    from: z.string(),
    to: z.string(),
    points: z.array(
      z.object({
        timestamp: z.string(),
        avg: z.number(),
        min: z.number(),
        max: z.number(),
        samples: z.number().int(),
      }),
    ),
    returned: z.number().int(),
    total: z.number().int(),
    truncated: z.boolean(),
    summary: z
      .object({
        min: z.number(),
        max: z.number(),
        avg: z.number(),
        latest: z.number(),
      })
      .nullable(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.view');
    const spanMs = RANGE_MS[args.range];
    const to = new Date();
    const from = new Date(to.getTime() - spanMs);
    const resolution = args.resolution ?? pickResolution(spanMs);

    const points = await querySeries(server.id, args.metric, from, to, resolution);
    const kept = points.slice(-CAPS.metricPoints);

    // Folded rather than spread into `Math.min`: a wide window at a fine resolution can be
    // tens of thousands of points, and spreading that many arguments blows the call stack.
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (const point of points) {
      if (point.min < min) min = point.min;
      if (point.max > max) max = point.max;
      sum += point.avg;
    }

    const summary =
      points.length === 0
        ? null
        : {
            min,
            max,
            avg: sum / points.length,
            latest: points[points.length - 1]?.avg ?? 0,
          };

    return {
      serverId: server.id,
      metric: args.metric,
      resolution,
      from: from.toISOString(),
      to: to.toISOString(),
      points: kept,
      returned: kept.length,
      total: points.length,
      truncated: kept.length < points.length,
      summary,
    };
  },
});

const observationSchema = z.object({
  code: z.string(),
  detail: z.string(),
  /** The log line or reading the observation is drawn from, so nothing here is unsupported. */
  evidence: z.string().nullable(),
});

type Observation = z.infer<typeof observationSchema>;

/** The runtime's own view, projected onto something an agent can read without a Docker manual. */
const containerStateSchema = z.object({
  exists: z.boolean(),
  running: z.boolean(),
  state: z.string(),
  exitCode: z.number().int().nullable(),
  oomKilled: z.boolean(),
  restarting: z.boolean(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

type ContainerStateOut = z.infer<typeof containerStateSchema>;

/** Signatures worth naming. Each one is a fact about the output, not a diagnosis of the game. */
/**
 * Java's class-file major version is 44 plus the language version: 65 is Java 21, 69 is
 * Java 25. Reporting "major version 69" to someone running a Minecraft server tells them
 * nothing; reporting "needs Java 25" tells them what to change.
 */
export function javaVersionFromClassFile(evidence: string): number | null {
  const match = /class file (?:major )?version (\d+)/i.exec(evidence);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) && major > 44 ? major - 44 : null;
}

/** Exposed for tests: the human-facing sentence built from one UnsupportedClassVersionError. */
export function diagnoseJavaVersion(evidence: string): string | null {
  const needed = javaVersionFromClassFile(evidence);
  if (needed === null) return null;
  const file = /([\w.-]+\.jar)/.exec(evidence)?.[1];
  const subject = file !== undefined ? `${file} needs` : 'It needs';
  return (
    `${subject} Java ${needed}. Either install a build of it made for the Java this ` +
    `server runs, or move the server to an image with Java ${needed}.`
  );
}

const LOG_SIGNATURES: ReadonlyArray<{
  code: string;
  pattern: RegExp;
  detail: string;
  /** Refines `detail` using the matched line, when the line carries specifics. */
  explain?: (evidence: string) => string | null;
}> = [
  {
    code: 'eula_not_accepted',
    pattern: /you need to agree to the eula/i,
    detail:
      'The Minecraft EULA has not been accepted. Set the EULA variable to true and reinstall.',
  },
  {
    code: 'port_in_use',
    pattern: /address already in use|failed to bind to port/i,
    detail:
      'The server could not bind its port. Another process holds it, or the allocation is stale.',
  },
  {
    code: 'jvm_out_of_memory',
    pattern: /java\.lang\.OutOfMemoryError/,
    detail:
      'The JVM exhausted its heap. Raise memoryMb, or reduce view distance and loaded chunks.',
  },
  {
    code: 'unsupported_java_version',
    pattern: /UnsupportedClassVersionError|has been compiled by a more recent version of the Java/i,
    detail:
      'Something the server loaded was built for a newer Java than this server runs. That is ' +
      'usually a mod or plugin rather than the game itself: the server keeps running and the ' +
      'mod simply never loads, which is why nothing looks broken.',
    explain: diagnoseJavaVersion,
  },
  {
    code: 'corrupt_world',
    pattern: /failed to load|chunk .*corrupt|level\.dat.*(missing|corrupt)/i,
    detail:
      'The world data could not be loaded. Restoring a backup is usually faster than repairing it.',
  },
  {
    code: 'exception_thrown',
    pattern: /^\s*(?:Caused by:|java\.\w+\.\w*Exception|Exception in thread)/,
    detail: 'The server threw an exception. The stack trace is in the returned log lines.',
  },
];

const diagnoseCrashTool = defineTool({
  name: 'diagnose_crash',
  title: 'Assemble crash evidence',
  description:
    'Gathers everything Platter knows about why a server stopped, in one call: the recorded exit ' +
    "code and crash time, the container runtime's own view (whether it exists, whether it was " +
    'OOM-killed, when it finished), current disk and memory against the configured limits, the ' +
    'blueprint crash patterns that matched, and the tail of the console.\n' +
    '`observations` are mechanical readings, each carrying the line or number it came from — they ' +
    'are evidence, not a verdict. Nothing here restarts, repairs or changes the server; decide what ' +
    'to do and use power_server, or tell the human. Works on a server that is currently running too, ' +
    'in which case it describes the last exit rather than a live crash.',
  input: z.object({
    serverId: serverIdArg,
    lines: z
      .number()
      .int()
      .min(10)
      .max(CAPS.logLines)
      .default(CAPS.diagnoseLines)
      .describe('How much console tail to include as evidence.'),
  }),
  output: z.object({
    serverId: z.string(),
    name: z.string(),
    status: z.string(),
    blueprintKey: z.string(),
    exit: z.object({
      lastExitCode: z.number().int().nullable(),
      lastCrashAt: z.string().nullable(),
      startedAt: z.string().nullable(),
      installedAt: z.string().nullable(),
      autoRestart: z.boolean(),
    }),
    container: containerStateSchema.nullable(),
    resources: z.object({
      memoryLimitMb: z.number().int(),
      memoryBytes: z.number().nullable(),
      diskLimitMb: z.number().int(),
      diskBytes: z.number().nullable(),
    }),
    crashPatternMatches: z.array(z.string()),
    observations: z.array(observationSchema),
    logs: z.array(logEntrySchema),
    logsUnavailable: z.string().nullable(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'console.read');
    const status = presentStatus(server);
    const blueprint = await findBlueprint(server.blueprintKey);
    const observations: Observation[] = [];

    let container: ContainerStateOut | null = null;
    let memoryBytes: number | null = null;
    let diskBytes: number | null = null;

    try {
      const driver = await getDriver(server.nodeId);
      const state = await driver.inspect(server.id);
      container = {
        exists: state.exists,
        running: state.running,
        state: state.state,
        exitCode: state.exitCode,
        oomKilled: state.oomKilled,
        restarting: state.restarting,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
      };
      if (state.running) {
        const usage = await driver.usage(server.id);
        memoryBytes = usage?.memoryBytes ?? null;
      }
      diskBytes = await driver.diskUsage(server.id).catch(() => null);
    } catch (error) {
      observations.push({
        code: 'runtime_unreachable',
        detail: describeFailure(error, 'The container runtime could not be queried.'),
        evidence: null,
      });
    }

    const read = await readRecentLines(server, Math.min(args.lines, CAPS.logLines), context.signal);
    const logs = withinLogBudget(toLogEntries(read.lines)).kept;

    // Facts from the runtime first: they are unambiguous in a way log text never is.
    if (container?.oomKilled === true) {
      observations.push({
        code: 'oom_killed',
        detail: `The kernel killed the container for exceeding its ${server.memoryMb} MB memory limit. Raise memoryMb or reduce the workload.`,
        evidence: null,
      });
    }
    const exitCode = container?.exitCode ?? server.lastExitCode;
    if (exitCode === 137) {
      observations.push({
        code: 'sigkill_exit',
        detail:
          'Exit 137 is SIGKILL: the process was killed rather than asked to stop. Usually an out-of-memory kill or a stop that outran its grace period.',
        evidence: 'exitCode 137',
      });
    } else if (exitCode !== null && exitCode !== 0) {
      observations.push({
        code: 'nonzero_exit',
        detail: `The process exited with code ${exitCode}.`,
        evidence: `exitCode ${exitCode}`,
      });
    }
    if (container !== null && !container.exists && server.installedAt !== null) {
      observations.push({
        code: 'container_missing',
        detail:
          'The container no longer exists. Starting the server recreates it from the stored configuration; the data directory is untouched.',
        evidence: null,
      });
    }
    if (server.installedAt === null) {
      observations.push({
        code: 'never_installed',
        detail: 'This server has never finished an install, so there may be no game files to run.',
        evidence: null,
      });
    }
    if (diskBytes !== null && server.diskMb > 0) {
      const usedRatio = diskBytes / (server.diskMb * 1024 * 1024);
      if (usedRatio >= 0.9) {
        observations.push({
          code: 'disk_pressure',
          detail: `The data directory is at ${Math.round(usedRatio * 100)}% of its ${server.diskMb} MB allowance. A server that cannot write dies mid-save.`,
          evidence: `${diskBytes} bytes used`,
        });
      }
    }

    for (const signature of LOG_SIGNATURES) {
      const hit = logs.find((entry) => signature.pattern.test(entry.content));
      if (hit) {
        // The refinement is additive: a signature that cannot say anything specific about
        // this particular line still reports what it always knew.
        const specific = signature.explain?.(hit.content) ?? null;
        observations.push({
          code: signature.code,
          detail: specific === null ? signature.detail : `${signature.detail} ${specific}`,
          evidence: hit.content,
        });
      }
    }

    const crashPatternMatches: string[] = [];
    for (const source of blueprint?.signals.crash ?? []) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(source);
      } catch {
        continue;
      }
      const hit = logs.find((entry) => pattern.test(entry.content));
      if (hit) crashPatternMatches.push(hit.content);
    }
    if (crashPatternMatches.length > 0) {
      observations.push({
        code: 'crash_pattern_matched',
        detail: "The blueprint's own crash pattern matched a log line.",
        evidence: crashPatternMatches[0] ?? null,
      });
    }

    if (observations.length === 0) {
      observations.push({
        code: 'no_signal',
        detail:
          'Nothing in the runtime state or the console tail explains a failure. If the server is behaving badly rather than exiting, get_metrics over a wider window is the next place to look.',
        evidence: null,
      });
    }

    return {
      serverId: server.id,
      name: server.name,
      status,
      blueprintKey: server.blueprintKey,
      exit: {
        lastExitCode: server.lastExitCode,
        lastCrashAt: server.lastCrashAt?.toISOString() ?? null,
        startedAt: server.startedAt?.toISOString() ?? null,
        installedAt: server.installedAt?.toISOString() ?? null,
        autoRestart: server.autoRestart,
      },
      container,
      resources: {
        memoryLimitMb: server.memoryMb,
        memoryBytes,
        diskLimitMb: server.diskMb,
        diskBytes,
      },
      crashPatternMatches,
      observations,
      logs,
      logsUnavailable: read.unavailable,
    };
  },
});

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

const modSummaryOutSchema = z.object({
  source: modSourceSchema,
  projectId: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  author: z.string().nullable(),
  downloads: z.number().int(),
  categories: z.array(z.string()),
  loaders: z.array(z.string()),
  gameVersions: z.array(z.string()),
  serverSide: z.string(),
  license: z.string().nullable(),
  url: z.string(),
});

const modVersionOutSchema = z.object({
  versionId: z.string(),
  versionNumber: z.string(),
  name: z.string(),
  channel: z.string(),
  gameVersions: z.array(z.string()),
  loaders: z.array(z.string()),
  publishedAt: z.string().nullable(),
  filename: z.string(),
  sizeBytes: z.number().int(),
  requiredDependencies: z.number().int(),
});

interface CompactableVersion {
  versionId: string;
  versionNumber: string;
  name: string;
  channel: string;
  gameVersions: string[];
  loaders: string[];
  publishedAt: string | null;
  file: { filename: string; sizeBytes: number };
  dependencies: readonly { kind: string }[];
}

function toVersionOut(version: CompactableVersion): z.infer<typeof modVersionOutSchema> {
  return {
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    name: version.name,
    channel: version.channel,
    gameVersions: version.gameVersions.slice(0, CAPS.gameVersions),
    loaders: version.loaders,
    publishedAt: version.publishedAt,
    filename: version.file.filename,
    sizeBytes: version.file.sizeBytes,
    requiredDependencies: version.dependencies.filter(
      (dependency) => dependency.kind === 'required',
    ).length,
  };
}

const searchModsTool = defineTool({
  name: 'search_mods',
  title: 'Search mods and plugins',
  description:
    'Searches Modrinth and CurseForge for mods this specific server could actually load. Results are ' +
    "pre-filtered to the server's loader and game version, and to projects that run server-side — a " +
    'client-only shader will not appear. Only games whose blueprint sets the `mods` feature are ' +
    'supported (today: minecraft-java); anything else is refused with a sentence saying so.\n' +
    "Arguments: `query` is free text; `category` narrows by the provider's own category slug; " +
    '`gameVersion` overrides the server\'s version, and "any" drops the version filter entirely for a ' +
    `wider look; \`source\` restricts to one provider. \`limit\` is capped at ${CAPS.modHits}.\n` +
    '`sources` reports each provider separately, so a provider that is down or unconfigured shows as ' +
    'an error rather than quietly shrinking the results. **This tool installs nothing** — call ' +
    'get_mod for the detail a human needs, then propose_mod.',
  input: z.object({
    serverId: serverIdArg,
    query: z.string().trim().max(120).optional(),
    category: z.string().trim().max(48).optional(),
    gameVersion: z.string().trim().max(32).optional(),
    source: modSourceSchema.optional(),
    limit: z.number().int().min(1).max(CAPS.modHits).default(10),
    offset: z.number().int().min(0).max(5000).default(0),
  }),
  output: z.object({
    hits: z.array(modSummaryOutSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    sources: z.array(
      z.object({ source: z.string(), total: z.number().int(), error: z.string().nullable() }),
    ),
    note: z.string(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.view');
    const result = await searchServerMods(
      server,
      {
        query: args.query ?? null,
        categories: args.category === undefined ? [] : [args.category],
        ...(args.source ? { sources: [args.source] } : {}),
        ...(args.gameVersion === undefined
          ? {}
          : { gameVersion: args.gameVersion === 'any' ? null : args.gameVersion }),
        limit: args.limit,
        offset: args.offset,
        signal: context.signal,
      },
      context.logger,
    );

    return {
      hits: result.hits.map((hit) => ({
        source: hit.source,
        projectId: hit.projectId,
        slug: hit.slug,
        title: hit.title,
        summary: truncate(hit.summary, CAPS.modSummary).text,
        author: hit.author,
        downloads: hit.downloads,
        categories: hit.categories.slice(0, CAPS.categories),
        loaders: hit.loaders,
        gameVersions: hit.gameVersions.slice(-CAPS.gameVersions),
        serverSide: hit.serverSide,
        license: hit.license,
        url: hit.url,
      })),
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      sources: result.sources.map((source) => ({
        source: source.source,
        total: source.total,
        error: source.error,
      })),
      note: 'Searching does not install anything. propose_mod creates a proposal for a human to approve.',
    };
  },
});

const getModTool = defineTool({
  name: 'get_mod',
  title: 'Get one mod in full',
  description:
    'Everything about one mod, and whether this server can load it: the full project description, ' +
    'author, licence, gallery images, source and issue links, download count, and the versions this ' +
    'server could actually run, newest first. `installed` is non-null when Platter already put it on ' +
    'this server. When nothing is compatible, `incompatibleReason` names the constraint that failed ' +
    '(wrong loader, wrong game version, client-side only) rather than returning an empty list.\n' +
    'This is the detail a human needs to judge a suggestion, so read it before proposing and quote ' +
    'the parts that justify your recommendation — licence, maintenance, download count, what it ' +
    `depends on. The description is truncated at ${CAPS.modDescription} characters; ` +
    '`descriptionTruncated` says when. **Installs nothing.**',
  input: z.object({
    serverId: serverIdArg,
    source: modSourceSchema,
    project: z
      .string()
      .min(1)
      .max(128)
      .describe('Modrinth slug or id, or a CurseForge numeric id.'),
  }),
  output: z.object({
    mod: modSummaryOutSchema.extend({
      description: z.string(),
      descriptionFormat: z.string(),
      descriptionTruncated: z.boolean(),
      gallery: z.array(z.object({ url: z.string(), title: z.string().nullable() })),
      licenseUrl: z.string().nullable(),
      sourceUrl: z.string().nullable(),
      issuesUrl: z.string().nullable(),
      wikiUrl: z.string().nullable(),
      updatedAt: z.string().nullable(),
    }),
    compatibleVersions: z.array(modVersionOutSchema),
    compatibleVersionsTruncated: z.boolean(),
    installed: z
      .object({
        versionId: z.string(),
        versionNumber: z.string(),
        filename: z.string(),
        target: z.string(),
        installedAt: z.string(),
        installedByName: z.string().nullable(),
      })
      .nullable(),
    target: z.enum(['mods', 'plugins']).nullable(),
    incompatibleReason: z.string().nullable(),
    note: z.string(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.view');
    const detail = await getServerMod(
      server,
      args.source,
      args.project,
      context.signal,
      context.logger,
    );
    const description = truncate(detail.mod.description, CAPS.modDescription);
    const versions = detail.compatibleVersions.slice(0, CAPS.modVersions);

    return {
      mod: {
        source: detail.mod.source,
        projectId: detail.mod.projectId,
        slug: detail.mod.slug,
        title: detail.mod.title,
        summary: truncate(detail.mod.summary, CAPS.modSummary).text,
        author: detail.mod.author,
        downloads: detail.mod.downloads,
        categories: detail.mod.categories.slice(0, CAPS.categories),
        loaders: detail.mod.loaders,
        gameVersions: detail.mod.gameVersions.slice(-CAPS.gameVersions),
        serverSide: detail.mod.serverSide,
        license: detail.mod.license,
        url: detail.mod.url,
        description: description.text,
        descriptionFormat: detail.mod.descriptionFormat,
        descriptionTruncated: description.truncated,
        gallery: detail.mod.gallery
          .slice(0, CAPS.modGallery)
          .map((image) => ({ url: image.url, title: image.title })),
        licenseUrl: detail.mod.licenseUrl,
        sourceUrl: detail.mod.sourceUrl,
        issuesUrl: detail.mod.issuesUrl,
        wikiUrl: detail.mod.wikiUrl,
        updatedAt: detail.mod.updatedAt,
      },
      compatibleVersions: versions.map(toVersionOut),
      compatibleVersionsTruncated: versions.length < detail.compatibleVersions.length,
      installed: detail.installed
        ? {
            versionId: detail.installed.versionId,
            versionNumber: detail.installed.versionNumber,
            filename: detail.installed.filename,
            target: detail.installed.target,
            installedAt: detail.installed.installedAt,
            installedByName: detail.installed.installedByName,
          }
        : null,
      target: detail.target,
      incompatibleReason: detail.incompatibleReason,
      note: 'Reading a mod does not install it. Use propose_mod to put it in front of a human.',
    };
  },
});

const listInstalledModsTool = defineTool({
  name: 'list_installed_mods',
  title: 'List installed mods',
  description:
    'Lists the mods and plugins Platter installed on this server, with the version, the file on disk, ' +
    'and who approved it. Only tracks what Platter installed: files an operator dropped into the ' +
    'mods folder by hand are not in the manifest and will not appear here. Read-only — this tool ' +
    'cannot install or remove anything.',
  input: z.object({ serverId: serverIdArg }),
  output: z.object({
    mods: z.array(
      z.object({
        source: z.string(),
        projectId: z.string(),
        slug: z.string(),
        title: z.string(),
        versionId: z.string(),
        versionNumber: z.string(),
        filename: z.string(),
        target: z.string(),
        sizeBytes: z.number().int(),
        installedAt: z.string(),
        installedByName: z.string().nullable(),
        proposalId: z.string().nullable(),
      }),
    ),
    total: z.number().int(),
    truncated: z.boolean(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.view');
    const installed = await listInstalledMods(server);
    const kept = installed.slice(0, CAPS.installedMods);
    return {
      mods: kept.map((mod) => ({
        source: mod.source,
        projectId: mod.projectId,
        slug: mod.slug,
        title: mod.title,
        versionId: mod.versionId,
        versionNumber: mod.versionNumber,
        filename: mod.filename,
        target: mod.target,
        sizeBytes: mod.sizeBytes,
        installedAt: mod.installedAt,
        installedByName: mod.installedByName,
        proposalId: mod.proposalId,
      })),
      total: installed.length,
      truncated: kept.length < installed.length,
    };
  },
});

const checkModUpdatesTool = defineTool({
  name: 'check_mod_updates',
  title: 'Check installed mods for updates',
  description:
    'Checks every mod Platter installed on this server for a newer version that is still compatible ' +
    "with the server's loader and game version. `prerelease` is true when the only newer build is a " +
    'beta or alpha — worth flagging to a human rather than proposing silently.\n' +
    'A mod whose project has been taken down, or whose provider is unconfigured, is skipped rather ' +
    'than failing the whole check. This makes one upstream request per installed mod, so do not poll ' +
    'it. **Updating is not installing**: to act on a result, call propose_mod with the new version ' +
    'and let a human approve it.',
  input: z.object({ serverId: serverIdArg }),
  output: z.object({
    updates: z.array(
      z.object({
        source: z.string(),
        projectId: z.string(),
        title: z.string(),
        installedVersion: z.string(),
        latestVersion: z.string(),
        latestVersionId: z.string(),
        prerelease: z.boolean(),
        publishedAt: z.string().nullable(),
      }),
    ),
    total: z.number().int(),
    note: z.string(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.view');
    const updates = await checkModUpdates(server, context.signal, context.logger);
    return {
      updates: updates.map((update) => ({
        source: update.installed.source,
        projectId: update.installed.projectId,
        title: update.installed.title,
        installedVersion: update.installed.versionNumber,
        latestVersion: update.latest.versionNumber,
        latestVersionId: update.latest.versionId,
        prerelease: update.prerelease,
        publishedAt: update.latest.publishedAt,
      })),
      total: updates.length,
      note: 'Nothing was updated. propose_mod with the version id above puts an update in the review queue.',
    };
  },
});

const proposeModTool = defineTool({
  name: 'propose_mod',
  title: 'Propose a mod for human approval',
  description:
    'Creates a pending proposal that a human reviews and approves in the Platter web UI.\n' +
    '**This tool does not install anything, and no tool in this MCP server can.** Installation is ' +
    'reachable only by a person approving the proposal; the module exposing these tools has no code ' +
    'path to the installer at all. What this call does is: resolve the mod and its dependencies ' +
    "against this server's loader and game version, snapshot exactly what the reviewer will be shown, " +
    'and store it. Nothing is downloaded and nothing on the server changes.\n' +
    '`rationale` is the most important argument: it is the first thing the reviewer reads. Say why ' +
    'this mod, on this server, for this person — not what the mod is. Use get_mod first so the ' +
    'reasoning cites something real.\n' +
    'Omit `version` to let Platter pick the newest compatible build. A proposal is still recorded ' +
    'when the plan is blocked (wrong loader, missing dependency): "this needs Fabric and you run ' +
    'Paper" is exactly what a reviewer should see. One pending proposal per project at a time. ' +
    'Track it with get_proposal_status.',
  input: z.object({
    serverId: serverIdArg,
    source: modSourceSchema,
    project: z
      .string()
      .min(1)
      .max(128)
      .describe('Modrinth slug or id, or a CurseForge numeric id.'),
    version: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe('A specific version id. Omit to take the newest version this server can load.'),
    rationale: z
      .string()
      .trim()
      .min(3)
      .max(2000)
      .describe(
        'Why this mod belongs on this server, in your own words. The reviewer reads this first.',
      ),
  }),
  output: z.object({
    proposalId: z.string(),
    status: z.string(),
    serverId: z.string(),
    mod: z.object({
      source: z.string(),
      projectId: z.string(),
      slug: z.string(),
      title: z.string(),
    }),
    versionId: z.string(),
    versionNumber: z.string(),
    installable: z.boolean(),
    dependencies: z.array(
      z.object({ title: z.string(), versionNumber: z.string(), reason: z.string() }),
    ),
    problems: z.array(z.object({ severity: z.string(), title: z.string(), message: z.string() })),
    installed: z.literal(false),
    nextStep: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    // `ai.use`, not `files.write`: proposing is the agent-facing half of the workflow and is
    // grantable without any ability to change the server. Approving needs `files.write`, and
    // there is no tool here that asks for it.
    const server = await authorizeServer(context.principal, args.serverId, 'ai.use');

    const proposal = await propose({
      server,
      source: args.source,
      projectRef: args.project,
      versionRef: args.version ?? null,
      rationale: args.rationale,
      proposedById: context.principal.user.id,
      proposedByName: context.actorName,
      signal: context.signal,
      log: context.logger,
    });

    const resolution = proposal.snapshot.resolution;
    return {
      proposalId: proposal.id,
      status: proposal.status,
      serverId: proposal.serverId,
      mod: {
        source: proposal.source,
        projectId: proposal.projectId,
        slug: proposal.slug,
        title: proposal.title,
      },
      versionId: proposal.versionId,
      versionNumber: proposal.versionNumber,
      installable: resolution.installable,
      dependencies: resolution.install
        .filter((entry) => entry.reason !== 'requested')
        .map((entry) => ({
          title: entry.title,
          versionNumber: entry.version.versionNumber,
          reason: entry.reason,
        })),
      problems: resolution.problems.map((problem) => ({
        severity: problem.severity,
        title: problem.title,
        message: problem.message,
      })),
      // Literal, not a boolean: the schema pins it to `false` so the answer to "did this
      // install anything" is fixed by the contract rather than by this line.
      installed: false as const,
      nextStep: resolution.installable
        ? "Nothing was installed. Tell the human this is waiting in the Platter web UI under the server's Mods tab, and what they should look at before approving."
        : 'Nothing was installed, and this proposal cannot be approved as it stands — see `problems`. Tell the human what would have to change.',
    };
  },
});

const getProposalStatusTool = defineTool({
  name: 'get_proposal_status',
  title: 'Check a mod proposal',
  description:
    'Reports where a mod proposal stands: `pending` (waiting for a human), `approved` (a human ' +
    'approved it and the files were installed), `rejected`, or `failed` (approved but the install ' +
    'errored — see `error`). `driftDetectedAt` is set when upstream changed after the proposal was ' +
    'raised, which blocks approval until a human re-reads the diff.\n' +
    'Pass `proposalId` for one proposal, or omit it to list the most recent proposals for the server. ' +
    'Read-only: an agent can watch the queue and cannot act on it.',
  input: z.object({
    serverId: serverIdArg,
    proposalId: z.string().min(3).max(64).optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'failed']).optional(),
  }),
  output: z.object({
    proposals: z.array(
      z.object({
        proposalId: z.string(),
        status: z.string(),
        source: z.string(),
        projectId: z.string(),
        title: z.string(),
        versionNumber: z.string(),
        rationale: z.string(),
        proposedByName: z.string().nullable(),
        proposedAt: z.string(),
        reviewedByName: z.string().nullable(),
        reviewedAt: z.string().nullable(),
        reviewNote: z.string().nullable(),
        driftDetectedAt: z.string().nullable(),
        installedVersionId: z.string().nullable(),
        error: z.string().nullable(),
      }),
    ),
    total: z.number().int(),
    truncated: z.boolean(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    await authorizeServer(context.principal, args.serverId, 'server.view');

    const found =
      args.proposalId === undefined
        ? await listProposals(args.serverId, args.status, context.logger)
        : [await getProposal(args.serverId, args.proposalId, context.logger)];

    const kept = found.slice(0, CAPS.proposals);
    return {
      proposals: kept.map((proposal) => ({
        proposalId: proposal.id,
        status: proposal.status,
        source: proposal.source,
        projectId: proposal.projectId,
        title: proposal.title,
        versionNumber: proposal.versionNumber,
        rationale: proposal.rationale,
        proposedByName: proposal.proposedByName,
        proposedAt: proposal.proposedAt,
        reviewedByName: proposal.reviewedByName,
        reviewedAt: proposal.reviewedAt,
        reviewNote: proposal.reviewNote,
        driftDetectedAt: proposal.driftDetectedAt,
        installedVersionId: proposal.installedVersionId,
        error: proposal.error,
      })),
      total: found.length,
      truncated: kept.length < found.length,
    };
  },
});

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

const playerNameArg = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .describe(
    'The player name exactly as the game knows it. The game is the authority on what is valid.',
  );

const reasonArg = z
  .string()
  .trim()
  .max(200)
  .optional()
  .describe('Shown to the player. Keep it short and say what would let them back in.');

const listPlayersTool = defineTool({
  name: 'list_players',
  title: 'List players',
  description:
    'Who is on the server now, and everyone it has ever seen, with playtime, session count, and ' +
    'operator / whitelist / ban flags. History comes back even when the server is off — that is the ' +
    'point of persisting it — so this never fails just because nothing is running.\n' +
    '`source` says where the live list came from: `rcon` and `query` are the running server; `logs` ' +
    'means nothing live could be reached and the online set is inferred from join/leave lines. When ' +
    'RCON is unavailable, `unavailable` and `unavailableMessage` say why. Read-only.',
  input: z.object({ serverId: serverIdArg }),
  output: z.object({
    serverId: z.string(),
    source: z.string(),
    onlineCount: z.number().int(),
    maxPlayers: z.number().int().nullable(),
    whitelistEnabled: z.boolean().nullable(),
    unavailable: z.string().nullable(),
    unavailableMessage: z.string().nullable(),
    players: z.array(
      z.object({
        name: z.string(),
        online: z.boolean(),
        playtimeMs: z.number(),
        sessions: z.number().int(),
        firstSeen: z.string().nullable(),
        lastSeen: z.string().nullable(),
        op: z.boolean(),
        whitelisted: z.boolean(),
        banned: z.boolean(),
        banReason: z.string().nullable(),
      }),
    ),
    total: z.number().int(),
    truncated: z.boolean(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.view');
    const roster = await getPlayerRoster(server.id);
    const kept = roster.players.slice(0, CAPS.players);

    return {
      serverId: server.id,
      source: roster.source,
      onlineCount: roster.onlineCount,
      maxPlayers: roster.maxPlayers,
      whitelistEnabled: roster.whitelistEnabled,
      unavailable: roster.unavailable,
      unavailableMessage: roster.unavailableMessage,
      players: kept.map((player) => ({
        name: player.name,
        online: player.online,
        playtimeMs: player.playtimeMs,
        sessions: player.sessions,
        firstSeen: player.firstSeen,
        lastSeen: player.lastSeen,
        op: player.op,
        whitelisted: player.whitelisted,
        banned: player.banned,
        banReason: player.banReason,
      })),
      total: roster.players.length,
      truncated: kept.length < roster.players.length,
    };
  },
});

const kickPlayerTool = defineTool({
  name: 'kick_player',
  title: 'Kick a player',
  description:
    'Disconnects a player who is currently online. They can rejoin immediately — this is a nudge, ' +
    'not a ban. Requires a running server with RCON reachable; if the game refuses (no such player, ' +
    'not online) its own words come back as the error.\n' +
    "The kick is sent as a console command and is written to the audit log with the calling agent's " +
    'identity. `reason` is shown to the player.',
  input: z.object({ serverId: serverIdArg, player: playerNameArg, reason: reasonArg }),
  output: z.object({
    serverId: z.string(),
    player: z.string(),
    action: z.literal('kick'),
    output: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'console.write');
    const output = await kickPlayer(server.id, args.player, args.reason ?? null, {
      logger: context.logger,
    });
    await auditMcp(context, {
      action: 'server.command',
      server,
      tool: 'kick_player',
      metadata: { command: 'kick', player: args.player, reason: args.reason ?? null },
    });
    return { serverId: server.id, player: args.player, action: 'kick' as const, output };
  },
});

const banPlayerTool = defineTool({
  name: 'ban_player',
  title: 'Ban a player',
  description:
    'Bans a player from the server and disconnects them if they are online. The ban persists in the ' +
    "game's own ban list and survives restarts; lifting it is a manual step in the web console.\n" +
    'Requires `confirm: true`. Called without it, the tool explains what would happen and bans ' +
    'nobody — ask the human first unless they have already asked for this specific ban. Requires a ' +
    "running server with RCON reachable. Audited with the calling agent's identity. To disconnect " +
    'someone without barring them, use kick_player.',
  input: z.object({
    serverId: serverIdArg,
    player: playerNameArg,
    reason: reasonArg,
    confirm: confirmArg,
  }),
  output: z.object({
    banned: z.boolean(),
    serverId: z.string(),
    player: z.string(),
    output: z.string().nullable(),
    message: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'console.write');

    if (!args.confirm) {
      return {
        banned: false,
        serverId: server.id,
        player: args.player,
        output: null,
        message:
          `Nobody was banned. Banning "${args.player}" bars them from ${server.name} until an ` +
          'operator lifts it by hand. Call again with confirm: true to proceed.',
      };
    }

    const output = await banPlayer(server.id, args.player, args.reason ?? null, {
      logger: context.logger,
    });
    await auditMcp(context, {
      action: 'server.command',
      server,
      tool: 'ban_player',
      metadata: { command: 'ban', player: args.player, reason: args.reason ?? null },
    });

    return {
      banned: true,
      serverId: server.id,
      player: args.player,
      output,
      message: `${args.player} is banned from ${server.name}.`,
    };
  },
});

const whitelistPlayerTool = defineTool({
  name: 'whitelist_player',
  title: 'Add or remove a whitelist entry',
  description:
    "Adds a player to, or removes them from, the server's whitelist. Requires a running server with " +
    "RCON reachable, and the change is written to the game's whitelist file, so it survives restarts.\n" +
    'Note that this only changes the list. Whether the whitelist is *enforced* is a separate server ' +
    'setting — check `whitelistEnabled` from list_players; if it is false, adding someone grants ' +
    'nothing and removing them bars nobody. Removing an entry does not disconnect a player who is ' +
    "already on. Audited with the calling agent's identity.",
  input: z.object({
    serverId: serverIdArg,
    player: playerNameArg,
    action: z.enum(['add', 'remove']).default('add'),
  }),
  output: z.object({
    serverId: z.string(),
    player: z.string(),
    action: z.enum(['add', 'remove']),
    whitelistEnabled: z.boolean().nullable(),
    output: z.string(),
    note: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'console.write');
    const output = await setWhitelisted(server.id, args.player, args.action === 'add', {
      logger: context.logger,
    });

    await auditMcp(context, {
      action: 'server.command',
      server,
      tool: 'whitelist_player',
      metadata: { command: `whitelist ${args.action}`, player: args.player },
    });

    // Read back rather than assume: the roster is the only place that knows whether the
    // whitelist is actually being enforced, and that is what decides if this did anything.
    const roster = await getPlayerRoster(server.id).catch(() => null);
    const enabled = roster?.whitelistEnabled ?? null;

    return {
      serverId: server.id,
      player: args.player,
      action: args.action,
      whitelistEnabled: enabled,
      output,
      note:
        enabled === false
          ? 'The whitelist is not currently enforced on this server, so this change has no effect until it is turned on.'
          : 'The whitelist file was updated.',
    };
  },
});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const getServerAddressTool = defineTool({
  name: 'get_server_address',
  title: 'Get the connection address',
  description:
    'The address players type to join, plus every other port this server has been allocated ' +
    '(query, RCON, and so on). `primary` is the one to give a player. Addresses are built from the ' +
    "node's configured public host, so they are only correct from wherever that host is reachable — " +
    'on a home network that is usually a LAN address, not a public one. Read-only.\n' +
    'To find out whether the port actually answers, use check_reachability.',
  input: z.object({ serverId: serverIdArg }),
  output: z.object({
    serverId: z.string(),
    name: z.string(),
    status: z.string(),
    publicHost: z.string(),
    primary: z
      .object({
        name: z.string(),
        address: z.string(),
        port: z.number().int(),
        protocol: z.enum(['tcp', 'udp']),
      })
      .nullable(),
    allocations: z.array(
      z.object({
        name: z.string(),
        address: z.string(),
        port: z.number().int(),
        protocol: z.enum(['tcp', 'udp']),
        primary: z.boolean(),
      }),
    ),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.view');
    const dto = await loadServerDto(server.id, context.logger);
    const node = await prisma.node.findUnique({
      where: { id: server.nodeId },
      select: { publicHost: true },
    });
    if (!node) throw notFound('node');

    const allocations = dto.allocations.map((allocation) => ({
      name: allocation.name,
      address: formatAddress(node.publicHost, allocation.hostPort),
      port: allocation.hostPort,
      protocol: allocation.protocol,
      primary: allocation.primary,
    }));
    const primary = allocations.find((allocation) => allocation.primary) ?? allocations[0] ?? null;

    return {
      serverId: server.id,
      name: server.name,
      status: presentStatus(server),
      publicHost: node.publicHost,
      primary: primary
        ? {
            name: primary.name,
            address: primary.address,
            port: primary.port,
            protocol: primary.protocol,
          }
        : null,
      allocations,
    };
  },
});

/**
 * A TCP connect probe.
 *
 * Connect-and-close is the whole test: it proves something is listening and accepting, which
 * is exactly the question "can a player reach this" reduces to for a TCP game. The socket is
 * destroyed on every path — a probe that leaked a half-open connection per call would be a
 * slow resource leak in a daemon that runs for months.
 */
function probeTcp(
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ reachable: boolean; latencyMs: number | null; detail: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket: Socket = connect({ host, port });

    const onCancel = (): void => {
      finish(false, 'The request was cancelled before the probe finished.');
    };

    function finish(reachable: boolean, detail: string): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onCancel);
      socket.destroy();
      resolve({ reachable, latencyMs: reachable ? Date.now() - started : null, detail });
    }

    signal.addEventListener('abort', onCancel, { once: true });
    // Set before the connection is established, so it bounds the connect itself and not just
    // idle time afterwards.
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish(true, 'Connected.');
    });
    socket.once('timeout', () => {
      finish(false, `No answer within ${timeoutMs} ms.`);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(
        false,
        error.code === 'ECONNREFUSED'
          ? 'Connection refused — nothing is listening.'
          : `Failed: ${error.code ?? error.message}`,
      );
    });
  });
}

const checkReachabilityTool = defineTool({
  name: 'check_reachability',
  title: 'Check whether the server answers',
  description:
    "Probes this server's allocated ports from the Platter host and reports which of them answer. " +
    'Use it to tell "the container is running" apart from "players can actually connect".\n' +
    'Important limits. The probe runs from the machine Platter is on, so it says nothing about ' +
    'whether a router, firewall or NAT lets the outside world in — a port that answers here can ' +
    'still be unreachable from the internet. TCP ports get a connect test. UDP ports cannot be ' +
    'probed that way and come back with `reachable: null`, except a Minecraft query port, which is ' +
    'asked for a real status. `reachable: null` means "not testable", never "down".\n' +
    'Read-only; it opens and immediately closes a connection and sends nothing to the game.',
  input: z.object({
    serverId: serverIdArg,
    timeoutMs: z.number().int().min(200).max(5000).default(2000),
  }),
  output: z.object({
    serverId: z.string(),
    status: z.string(),
    publicHost: z.string(),
    checks: z.array(
      z.object({
        name: z.string(),
        port: z.number().int(),
        protocol: z.enum(['tcp', 'udp']),
        reachable: z.boolean().nullable(),
        latencyMs: z.number().int().nullable(),
        detail: z.string(),
      }),
    ),
    summary: z.string(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const server = await authorizeServer(context.principal, args.serverId, 'server.view');
    const dto = await loadServerDto(server.id, context.logger);
    const node = await prisma.node.findUnique({
      where: { id: server.nodeId },
      select: { publicHost: true },
    });
    if (!node) throw notFound('node');

    const blueprint = await findBlueprint(server.blueprintKey);
    const serverType = (dto.variables['TYPE'] ?? 'VANILLA').toUpperCase();
    const queryCapable =
      blueprint?.key === 'minecraft-java' &&
      minecraftSupportsQuery(serverType) &&
      dto.variables['ENABLE_QUERY'] !== 'false';

    const targets = dto.allocations.slice(0, CAPS.addressChecks);
    const checks = await Promise.all(
      targets.map(async (allocation) => {
        if (allocation.protocol === 'tcp') {
          const result = await probeTcp(
            node.publicHost,
            allocation.hostPort,
            args.timeoutMs,
            context.signal,
          );
          return {
            name: allocation.name,
            port: allocation.hostPort,
            protocol: allocation.protocol,
            reachable: result.reachable,
            latencyMs: result.latencyMs,
            detail: result.detail,
          };
        }

        if (allocation.name === 'query' && queryCapable) {
          const outcome = await tryQueryBasic({
            host: node.publicHost,
            port: allocation.hostPort,
            timeoutMs: args.timeoutMs,
            signal: context.signal,
          });
          return {
            name: allocation.name,
            port: allocation.hostPort,
            protocol: allocation.protocol,
            reachable: outcome.ok,
            latencyMs: null,
            detail: outcome.ok
              ? `Answered: ${outcome.stat.onlinePlayers}/${outcome.stat.maxPlayers} players on ${outcome.stat.map}.`
              : `Query ${outcome.reason}.`,
          };
        }

        return {
          name: allocation.name,
          port: allocation.hostPort,
          protocol: allocation.protocol,
          reachable: null,
          latencyMs: null,
          detail:
            'UDP ports cannot be probed by connecting. This is not a failure — the port may well be fine.',
        };
      }),
    );

    const answered = checks.filter((check) => check.reachable === true).length;
    const failed = checks.filter((check) => check.reachable === false).length;

    return {
      serverId: server.id,
      status: presentStatus(server),
      publicHost: node.publicHost,
      checks,
      summary:
        `${answered} of ${checks.length} allocated ports answered from the Platter host` +
        (failed > 0 ? `; ${failed} did not.` : '.') +
        ' This does not prove the server is reachable from the internet.',
    };
  },
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PLATTER_TOOLS: readonly McpTool[] = [
  listServersTool,
  getServerTool,
  listBlueprintsTool,
  getBlueprintTool,
  createServerTool,
  deleteServerTool,
  powerServerTool,
  sendConsoleCommandTool,
  getServerStatusTool,
  getLogsTool,
  searchLogsTool,
  getMetricsTool,
  diagnoseCrashTool,
  searchModsTool,
  getModTool,
  listInstalledModsTool,
  checkModUpdatesTool,
  proposeModTool,
  getProposalStatusTool,
  listPlayersTool,
  kickPlayerTool,
  banPlayerTool,
  whitelistPlayerTool,
  getServerAddressTool,
  checkReachabilityTool,
];

const TOOLS_BY_NAME: ReadonlyMap<string, McpTool> = new Map(
  PLATTER_TOOLS.map((tool) => [tool.name, tool]),
);

// A duplicate name would silently shadow a tool, which is the kind of mistake that only
// shows up as "the agent called delete and got a list". Caught at module load instead.
if (TOOLS_BY_NAME.size !== PLATTER_TOOLS.length) {
  throw new Error('duplicate MCP tool name');
}

export function getTool(name: string): McpTool | undefined {
  return TOOLS_BY_NAME.get(name);
}

export const TOOL_NAMES: readonly string[] = PLATTER_TOOLS.map((tool) => tool.name);
