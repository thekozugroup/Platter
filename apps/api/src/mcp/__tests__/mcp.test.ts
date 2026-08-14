import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
// Type-only, so these are erased: the modules themselves are imported after the environment
// is configured, further down.
import type * as ModsService from '../../services/mods.js';
import type { McpPrincipal } from '../auth.js';

/**
 * The MCP surface, driven by a real MCP client over the SDK's in-memory transport.
 *
 * The important tests here are not "does it return data" — they are the four properties the
 * feature rests on: an agent cannot install a mod, a destructive tool will not fire without
 * confirmation, an under-scoped key is refused, and a protocol error is a protocol error
 * rather than a cheerful result that says "error" in prose.
 */

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const srcRoot = path.join(apiRoot, 'src');
const workdir = await mkdtemp(path.join(tmpdir(), 'platter-mcp-'));

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'test.db')}`;
process.env['DATA_DIR'] = path.join(workdir, 'data');
process.env['DEFAULT_NODE_DRIVER'] = 'mock';
process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass';

execFileSync(path.join(apiRoot, 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
  cwd: apiRoot,
  env: process.env,
  stdio: 'ignore',
});

/**
 * Only the upstream half of the mod service is replaced: resolving a project against Modrinth
 * is a network call, and it is not what these tests are about. Everything the proposal path
 * actually does — deduplication, the snapshot, the material digest, the write — stays real.
 *
 * `applyResolution` is replaced with a spy that fails loudly. It is the one function that can
 * put a file on a server's disk, and a test that only checked the disk afterwards would pass
 * just as happily if the installer had been called and failed.
 */
const installerSpy = vi.hoisted(() => vi.fn());
const planSpy = vi.hoisted(() => vi.fn());

vi.mock('../../services/mods.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ModsService>();
  return {
    ...actual,
    planModInstall: planSpy,
    applyResolution: installerSpy,
  };
});

const { prisma } = await import('../../db.js');
const { generateApiKey } = await import('../../plugins/auth.js');
const { modDetailSchema, modVersionSchema } = await import('../../mods/registry.js');
const { resolutionSchema } = await import('../../mods/resolve.js');
const { serverDataDir } = await import('../../services/lifecycle.js');
const { resolveApiKeyPrincipal } = await import('../auth.js');
const { createMcpServer } = await import('../server.js');
const { PLATTER_TOOLS, TOOL_NAMES } = await import('../tools.js');

const NODE_ID = 'nod_test';
const OWNER_ID = 'usr_owner';
const STRANGER_ID = 'usr_stranger';
const SERVER_ID = 'srv_test';

/** Silent, and not the stdio logger: a test run should not paint stderr. */
function silentLogger(): FastifyBaseLogger {
  const noop = (): void => {};
  const logger: FastifyBaseLogger = {
    level: 'silent',
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => logger,
  };
  return logger;
}

interface SeededKey {
  token: string;
  id: string;
}

async function seedKey(name: string, userId: string, scopes: string[]): Promise<SeededKey> {
  const generated = generateApiKey();
  const row = await prisma.apiKey.create({
    data: {
      id: `key_${name}`,
      userId,
      name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes: JSON.stringify(scopes),
    },
  });
  return { token: generated.token, id: row.id };
}

let fullKey: SeededKey;
let viewOnlyKey: SeededKey;
let strangerKey: SeededKey;

async function seed(): Promise<void> {
  await prisma.user.createMany({
    data: [
      {
        id: OWNER_ID,
        email: 'owner@example.com',
        username: 'owner',
        displayName: 'Ada Lovelace',
        passwordHash: 'x',
        role: 'member',
      },
      {
        id: STRANGER_ID,
        email: 'stranger@example.com',
        username: 'stranger',
        displayName: 'Nobody',
        passwordHash: 'x',
        role: 'member',
      },
    ],
  });

  await prisma.node.create({
    data: {
      id: NODE_ID,
      name: 'local',
      driver: 'mock',
      endpoint: '/var/run/docker.sock',
      publicHost: '127.0.0.1',
      portRangeStart: 25000,
      portRangeEnd: 25999,
      memoryTotalMb: 16384,
      diskTotalMb: 512000,
      cpuCores: 8,
      status: 'online',
    },
  });

  await prisma.server.create({
    data: {
      id: SERVER_ID,
      name: 'Survival',
      blueprintKey: 'minecraft-java',
      nodeId: NODE_ID,
      ownerId: OWNER_ID,
      status: 'offline',
      memoryMb: 4096,
      diskMb: 10240,
      cpuCores: 0,
      variables: JSON.stringify({
        EULA: 'true',
        TYPE: 'PAPER',
        VERSION: '1.21.1',
        RCON_PASSWORD: 'super-secret-value',
      }),
    },
  });

  await prisma.allocation.create({
    data: {
      id: 'alc_game',
      nodeId: NODE_ID,
      hostPort: 25565,
      protocol: 'tcp',
      serverId: SERVER_ID,
      portName: 'game',
      primary: true,
    },
  });

  fullKey = await seedKey('full', OWNER_ID, []);
  viewOnlyKey = await seedKey('viewonly', OWNER_ID, ['server.view']);
  strangerKey = await seedKey('stranger', STRANGER_ID, []);
}

async function truncate(): Promise<void> {
  await prisma.setting.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.allocation.deleteMany();
  await prisma.server.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.node.deleteMany();
  await prisma.user.deleteMany();
}

interface Session {
  client: Client;
  close(): Promise<void>;
}

async function connect(token: string): Promise<Session> {
  const principal: McpPrincipal = await resolveApiKeyPrincipal(token, { ip: '10.0.0.1' });
  const server = createMcpServer({ principal: () => principal, logger: silentLogger() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '9.9.9' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** `callTool` never throws for an execution failure, so tests read the flag rather than catch. */
interface ToolCall {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCall> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as { type?: string; text?: string } | undefined;
  return {
    isError: result.isError === true,
    text: first?.text ?? '',
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
  };
}

beforeEach(async () => {
  await truncate();
  await seed();
  installerSpy.mockReset();
  planSpy.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('handshake and manifest', () => {
  it('completes an initialize handshake and advertises tools and resources', async () => {
    const session = await connect(fullKey.token);
    try {
      expect(session.client.getServerVersion()?.name).toBe('platter');
      expect(session.client.getServerCapabilities()?.tools).toBeDefined();
      expect(session.client.getServerCapabilities()?.resources).toBeDefined();
      // The instructions are the only place the safety rules are stated once, up front.
      expect(session.client.getInstructions()).toContain('You cannot install a mod');
    } finally {
      await session.close();
    }
  });

  it('lists every tool with a well-formed schema on both sides', async () => {
    const session = await connect(fullKey.token);
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

      for (const tool of tools) {
        expect(tool.inputSchema.type, tool.name).toBe('object');
        expect(tool.outputSchema?.type, tool.name).toBe('object');
        // Tool descriptions are the agent's only documentation; a stub is a bug.
        expect((tool.description ?? '').length, tool.name).toBeGreaterThan(80);
        expect(tool.annotations?.title, tool.name).toBeTruthy();
        // Nothing may leak the meta-schema URL into a client's context.
        expect(tool.inputSchema['$schema'], tool.name).toBeUndefined();
      }
    } finally {
      await session.close();
    }
  });

  it('pins the set of tools that can change anything', async () => {
    // A new write tool has to be added here deliberately. That is the point: the write
    // surface of an agent-facing API should never grow by accident.
    const writers = PLATTER_TOOLS.filter((tool) => tool.annotations.readOnlyHint !== true)
      .map((tool) => tool.name)
      .sort();
    expect(writers).toEqual([
      'ban_player',
      'create_server',
      'delete_server',
      'kick_player',
      'power_server',
      'propose_mod',
      'send_console_command',
      'whitelist_player',
    ]);
  });
});

describe('protocol errors', () => {
  it('rejects an unknown tool with a JSON-RPC error, not a tool result', async () => {
    const session = await connect(fullKey.token);
    try {
      await expect(
        session.client.callTool({ name: 'install_mod', arguments: {} }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally {
      await session.close();
    }
  });

  it('rejects malformed arguments with a JSON-RPC error naming the field', async () => {
    const session = await connect(fullKey.token);
    try {
      const failure = await session.client
        .callTool({ name: 'get_server', arguments: {} })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(McpError);
      expect((failure as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((failure as McpError).message).toContain('serverId');
    } finally {
      await session.close();
    }
  });

  it('refuses an argument outside the response cap at the schema boundary', async () => {
    const session = await connect(fullKey.token);
    try {
      await expect(
        session.client.callTool({
          name: 'get_logs',
          arguments: { serverId: SERVER_ID, lines: 50_000 },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally {
      await session.close();
    }
  });

  it('reports an execution failure as a tool result so the agent can read it', async () => {
    const session = await connect(fullKey.token);
    try {
      const result = await call(session.client, 'get_server', { serverId: 'srv_missing' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('not_found');
    } finally {
      await session.close();
    }
  });
});

describe('authorisation', () => {
  it('lets a full key read the servers it owns', async () => {
    const session = await connect(fullKey.token);
    try {
      const result = await call(session.client, 'list_servers');
      expect(result.isError).toBe(false);
      expect(result.structured['total']).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('rejects an under-privileged key on a tool outside its scopes', async () => {
    const session = await connect(viewOnlyKey.token);
    try {
      const readable = await call(session.client, 'list_servers');
      expect(readable.isError).toBe(false);

      const denied = await call(session.client, 'delete_server', {
        serverId: SERVER_ID,
        confirm: true,
        confirmServerName: 'Survival',
      });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('forbidden');
      expect(denied.text).toContain('server.delete');

      // And the scope check ran before anything touched the row.
      expect(await prisma.server.count()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("answers 'not found' for a server the principal has no relationship to", async () => {
    const session = await connect(strangerKey.token);
    try {
      const result = await call(session.client, 'get_server', { serverId: SERVER_ID });
      // Never `forbidden`: that would confirm the server exists.
      expect(result.isError).toBe(true);
      expect(result.text).toContain('not_found');
    } finally {
      await session.close();
    }
  });

  it('redacts password variables from server configuration', async () => {
    const session = await connect(fullKey.token);
    try {
      const result = await call(session.client, 'get_server', { serverId: SERVER_ID });
      const server = result.structured['server'] as { variables: Record<string, string> };
      expect(server.variables['RCON_PASSWORD']).toBe('[redacted]');
      expect(result.structured['redactedVariables']).toEqual(['RCON_PASSWORD']);
      expect(JSON.stringify(result.structured)).not.toContain('super-secret-value');
    } finally {
      await session.close();
    }
  });
});

describe('destructive tools', () => {
  it('refuses to delete without both confirmations and changes nothing', async () => {
    const session = await connect(fullKey.token);
    try {
      const unconfirmed = await call(session.client, 'delete_server', { serverId: SERVER_ID });
      expect(unconfirmed.isError).toBe(false);
      expect(unconfirmed.structured['deleted']).toBe(false);
      expect(String(unconfirmed.structured['message'])).toContain('confirm: true');

      const wrongName = await call(session.client, 'delete_server', {
        serverId: SERVER_ID,
        confirm: true,
        confirmServerName: 'Not The Server',
      });
      expect(wrongName.structured['deleted']).toBe(false);

      expect(await prisma.server.count()).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'server.deleted' } })).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('refuses a stop without confirmation', async () => {
    await prisma.server.update({ where: { id: SERVER_ID }, data: { status: 'running' } });
    const session = await connect(fullKey.token);
    try {
      const result = await call(session.client, 'power_server', {
        serverId: SERVER_ID,
        action: 'stop',
      });
      expect(result.isError).toBe(false);
      expect(result.structured['applied']).toBe(false);
      expect(result.structured['statusAfter']).toBe('running');
      expect(await prisma.auditLog.count({ where: { action: 'server.power' } })).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('refuses a ban without confirmation before it reaches the game', async () => {
    const session = await connect(fullKey.token);
    try {
      const result = await call(session.client, 'ban_player', {
        serverId: SERVER_ID,
        player: 'Steve',
      });
      expect(result.structured['banned']).toBe(false);
      expect(result.structured['output']).toBeNull();
    } finally {
      await session.close();
    }
  });

  it('refuses a power transition the lifecycle forbids, and says what is legal', async () => {
    await prisma.server.update({ where: { id: SERVER_ID }, data: { status: 'installing' } });
    const session = await connect(fullKey.token);
    try {
      const result = await call(session.client, 'power_server', {
        serverId: SERVER_ID,
        action: 'start',
        confirm: true,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('invalid_state');
      expect(result.text).toContain('kill');
    } finally {
      await session.close();
    }
  });
});

describe('propose_mod', () => {
  function fakePlan(): unknown {
    const detail = modDetailSchema.parse({
      source: 'modrinth',
      projectId: 'AANobbMI',
      slug: 'sodium',
      title: 'Sodium',
      summary: 'A modern rendering engine.',
      description: 'Long description.',
      license: 'LGPL-3.0-only',
      serverSide: 'optional',
      url: 'https://modrinth.com/mod/sodium',
    });
    const version = modVersionSchema.parse({
      source: 'modrinth',
      projectId: 'AANobbMI',
      versionId: 'ver_1',
      name: 'Sodium 0.5.8',
      versionNumber: '0.5.8',
      gameVersions: ['1.21.1'],
      loaders: ['paper'],
      file: {
        filename: 'sodium-0.5.8.jar',
        url: 'https://cdn.modrinth.com/sodium-0.5.8.jar',
        sizeBytes: 512,
        sha512: 'a'.repeat(128),
      },
    });
    const resolution = resolutionSchema.parse({
      install: [
        {
          source: 'modrinth',
          projectId: 'AANobbMI',
          slug: 'sodium',
          title: 'Sodium',
          target: 'plugins',
          version,
          reason: 'requested',
        },
      ],
      satisfied: [],
      problems: [],
      installable: true,
    });
    return {
      context: {
        serverId: SERVER_ID,
        serverName: 'Survival',
        blueprintKey: 'minecraft-java',
        serverType: 'PAPER',
        gameVersion: '1.21.1',
        loaders: ['paper', 'bukkit', 'spigot'],
        target: 'plugins',
        installed: [],
      },
      detail,
      version,
      resolution,
    };
  }

  it('records a proposal, installs nothing, and never reaches the installer', async () => {
    planSpy.mockResolvedValue(fakePlan());
    const session = await connect(fullKey.token);
    try {
      const result = await call(session.client, 'propose_mod', {
        serverId: SERVER_ID,
        source: 'modrinth',
        project: 'sodium',
        rationale: 'Paper server with a full render distance; this is the standard fix.',
      });

      expect(result.isError).toBe(false);
      expect(result.structured['installed']).toBe(false);
      expect(result.structured['status']).toBe('pending');
      const proposalId = String(result.structured['proposalId']);
      expect(proposalId).toMatch(/^mpr_/);

      // It really is durable, and it really is pending.
      const stored = await prisma.setting.findMany({
        where: { key: { startsWith: `mods.proposal.${SERVER_ID}.` } },
      });
      expect(stored).toHaveLength(1);
      expect(JSON.parse(stored[0]!.value).status).toBe('pending');

      // The one function that could put a file on disk was never called…
      expect(installerSpy).not.toHaveBeenCalled();
      // …and nothing appeared where a mod would land.
      await expect(stat(path.join(serverDataDir(SERVER_ID), 'plugins'))).rejects.toThrow();
    } finally {
      await session.close();
    }
  });

  it('carries the agent identity onto the proposal so a reviewer sees who asked', async () => {
    planSpy.mockResolvedValue(fakePlan());
    const session = await connect(fullKey.token);
    try {
      await call(session.client, 'propose_mod', {
        serverId: SERVER_ID,
        source: 'modrinth',
        project: 'sodium',
        rationale: 'Rendering performance.',
      });

      const stored = await prisma.setting.findFirst({
        where: { key: { startsWith: `mods.proposal.${SERVER_ID}.` } },
      });
      const proposal = JSON.parse(stored!.value) as {
        proposedById: string;
        proposedByName: string;
      };
      expect(proposal.proposedById).toBe(OWNER_ID);
      expect(proposal.proposedByName).toContain('test-agent');
      expect(proposal.proposedByName).toContain('Ada Lovelace');
    } finally {
      await session.close();
    }
  });

  it('requires ai.use, which a view-only key does not hold', async () => {
    planSpy.mockResolvedValue(fakePlan());
    const session = await connect(viewOnlyKey.token);
    try {
      const result = await call(session.client, 'propose_mod', {
        serverId: SERVER_ID,
        source: 'modrinth',
        project: 'sodium',
        rationale: 'Rendering performance.',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('ai.use');
      expect(await prisma.setting.count()).toBe(0);
    } finally {
      await session.close();
    }
  });
});

describe('the installer is not reachable from this module', () => {
  const MCP_SOURCES = [
    'mcp/auth.ts',
    'mcp/tools.ts',
    'mcp/resources.ts',
    'mcp/server.ts',
    'mcp/stdio.ts',
    'routes/mcp.ts',
  ];

  /** Every named binding this file imports, paired with the module it came from. */
  function importsOf(source: string): Array<{ specifier: string; bindings: string[] }> {
    const found: Array<{ specifier: string; bindings: string[] }> = [];
    const named = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g;
    for (const match of source.matchAll(named)) {
      const bindings = (match[1] ?? '')
        .split(',')
        .map(
          (entry) =>
            entry
              .replace(/^\s*type\s+/, '')
              .split(/\s+as\s+/)[0]
              ?.trim() ?? '',
        )
        .filter((entry) => entry.length > 0);
      found.push({ specifier: match[2] ?? '', bindings });
    }
    const bare = /import\s+(?:type\s+)?(?:\w+|\*\s+as\s+\w+)\s+from\s+'([^']+)'/g;
    for (const match of source.matchAll(bare)) {
      found.push({ specifier: match[1] ?? '', bindings: [] });
    }
    return found;
  }

  /** The symbols that can write a mod file to a server's volume, or authorise one. */
  const BANNED_BINDINGS = new Set([
    'applyResolution',
    'approve',
    'forgetInstalledMod',
    'installModFile',
    'recordInstalledMod',
    'removeInstalledMod',
    'removeModFile',
  ]);

  it('imports neither the installer module nor any symbol that writes a mod', async () => {
    for (const relative of MCP_SOURCES) {
      const source = await readFile(path.join(srcRoot, relative), 'utf8');

      for (const entry of importsOf(source)) {
        expect(entry.specifier, `${relative} imports ${entry.specifier}`).not.toMatch(
          /mods\/install/,
        );
        for (const binding of entry.bindings) {
          expect(BANNED_BINDINGS.has(binding), `${relative} imports ${binding}`).toBe(false);
        }
      }

      // A dynamic import would sidestep the scan above entirely.
      expect(source, relative).not.toMatch(/import\s*\(\s*['"][^'"]*mods\/install/);
      expect(source, relative).not.toMatch(/\brequire\s*\(\s*['"][^'"]*mods\/install/);
    }
  });

  it('exposes no tool that installs, updates or removes a file', () => {
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(/^(install|uninstall|update_mod|remove)/);
    }
    expect(TOOL_NAMES).toContain('propose_mod');
  });
});

describe('resources', () => {
  it('lists the fixed resources plus one pair per visible server', async () => {
    const session = await connect(fullKey.token);
    try {
      const { resources } = await session.client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain('platter://servers');
      expect(uris).toContain('platter://blueprints');
      expect(uris).toContain(`platter://servers/${SERVER_ID}/config`);
      expect(uris).toContain(`platter://servers/${SERVER_ID}/logs`);

      const { resourceTemplates } = await session.client.listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
        'platter://servers/{serverId}/config',
        'platter://servers/{serverId}/logs',
      ]);
    } finally {
      await session.close();
    }
  });

  it('reads the blueprint catalogue and a redacted server configuration', async () => {
    const session = await connect(fullKey.token);
    try {
      const catalogue = await session.client.readResource({ uri: 'platter://blueprints' });
      const body = JSON.parse(String(catalogue.contents[0]?.text)) as {
        blueprints: { key: string }[];
        minecraftServerTypes: { type: string }[];
      };
      expect(body.blueprints.some((blueprint) => blueprint.key === 'minecraft-java')).toBe(true);
      expect(body.minecraftServerTypes.some((entry) => entry.type === 'PAPER')).toBe(true);

      const config = await session.client.readResource({
        uri: `platter://servers/${SERVER_ID}/config`,
      });
      const text = String(config.contents[0]?.text);
      expect(text).not.toContain('super-secret-value');
      expect(text).toContain('[redacted]');
    } finally {
      await session.close();
    }
  });

  it('fails an unknown resource URI rather than returning empty contents', async () => {
    const session = await connect(fullKey.token);
    try {
      await expect(session.client.readResource({ uri: 'platter://nope' })).rejects.toBeInstanceOf(
        McpError,
      );
    } finally {
      await session.close();
    }
  });

  /**
   * The round-three finding, and the reason this is written as a loop over every static URI
   * rather than as one case.
   *
   * `listResources` checked `server.view` and the `list_servers` tool called `assertScope`,
   * but `readServerList` — the path that returns the same inventory in full — checked
   * nothing. The scope enforced on two surfaces out of three is the exact shape of the bug
   * round one closed on the audit route, and an `audit.read`-only key is precisely what an
   * operator hands to a third-party log shipper.
   */
  it('enforces server.view on every read path, not just the list and the tool', async () => {
    const auditOnly = await seedKey('auditonly', OWNER_ID, ['audit.read']);
    const powerOnly = await seedKey('poweronly', OWNER_ID, ['power.stop']);

    for (const key of [auditOnly, powerOnly]) {
      const session = await connect(key.token);
      try {
        // The tool has always refused; the resource must refuse identically.
        const viaTool = await call(session.client, 'list_servers', {});
        expect(viaTool.isError).toBe(true);

        await expect(session.client.readResource({ uri: 'platter://servers' })).rejects.toThrow(
          /server\.view/,
        );

        await expect(
          session.client.readResource({ uri: `platter://servers/${SERVER_ID}/config` }),
        ).rejects.toThrow(/server\.view/);

        // And nothing about the install leaks through the listing either.
        const { resources } = await session.client.listResources();
        const uris = resources.map((resource) => resource.uri);
        expect(uris).not.toContain(`platter://servers/${SERVER_ID}/config`);
      } finally {
        await session.close();
      }
    }
  });

  it('still serves the catalogue to a key with any scope — it names no server', async () => {
    const auditOnly = await seedKey('auditonly2', OWNER_ID, ['audit.read']);
    const session = await connect(auditOnly.token);
    try {
      const catalogue = await session.client.readResource({ uri: 'platter://blueprints' });
      expect(String(catalogue.contents[0]?.text)).toContain('minecraft-java');
    } finally {
      await session.close();
    }
  });
});

describe('bounded reads', () => {
  it('returns no lines and an explanation when the container does not exist', async () => {
    const session = await connect(fullKey.token);
    try {
      const result = await call(session.client, 'get_logs', { serverId: SERVER_ID, lines: 10 });
      expect(result.isError).toBe(false);
      expect(result.structured['lines']).toEqual([]);
      expect(String(result.structured['unavailable'])).toContain('no container');
    } finally {
      await session.close();
    }
  });

  it('assembles crash evidence without a container to inspect', async () => {
    await prisma.server.update({
      where: { id: SERVER_ID },
      data: { status: 'crashed', lastExitCode: 137, lastCrashAt: new Date() },
    });
    const session = await connect(fullKey.token);
    try {
      const result = await call(session.client, 'diagnose_crash', { serverId: SERVER_ID });
      expect(result.isError).toBe(false);
      const observations = result.structured['observations'] as { code: string }[];
      expect(observations.map((observation) => observation.code)).toContain('sigkill_exit');
      expect(observations.map((observation) => observation.code)).toContain('never_installed');
    } finally {
      await session.close();
    }
  });
});

describe('http transport', () => {
  /**
   * A real socket rather than `app.inject`: the transport hijacks the reply and writes an SSE
   * stream straight to it, which is exactly the part that a synthetic request would not
   * exercise. This is the only test here that binds a port; it binds 0 on loopback.
   */
  it('serves a full session over Streamable HTTP and tears it down on DELETE', async () => {
    const [
      { default: Fastify },
      { default: errorHandler },
      { default: mcpRoutes },
      { Client: HttpClient },
      { StreamableHTTPClientTransport },
    ] = await Promise.all([
      import('fastify'),
      import('../../plugins/error-handler.js'),
      import('../../routes/mcp.js'),
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);

    const app = Fastify({ logger: false });
    await app.register(errorHandler);
    await app.register(mcpRoutes, { prefix: '/mcp' });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { 'x-api-key': fullKey.token } },
    });
    const client = new HttpClient({ name: 'http-agent', version: '1.0.0' });

    try {
      await client.connect(transport);
      // The session id only exists if the server minted one and returned it in the header.
      expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);

      const { tools } = await client.listTools();
      expect(tools.length).toBe(TOOL_NAMES.length);

      const result = await client.callTool({ name: 'list_servers', arguments: {} });
      expect((result.structuredContent as { total: number }).total).toBe(1);

      await transport.terminateSession();
      expect(transport.sessionId).toBeUndefined();
    } finally {
      await client.close().catch(() => {});
      await app.close();
    }
  }, 30_000);

  it('refuses every method without an API key, and an unknown session with one', async () => {
    const [{ default: Fastify }, { default: errorHandler }, { default: mcpRoutes }] =
      await Promise.all([
        import('fastify'),
        import('../../plugins/error-handler.js'),
        import('../../routes/mcp.js'),
      ]);

    const app = Fastify({ logger: false });
    await app.register(errorHandler);
    await app.register(mcpRoutes, { prefix: '/mcp' });
    await app.ready();

    try {
      const anonymous = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json().error.code).toBe('unauthenticated');

      // A browser session token is not a credential for the agent surface.
      const jwtish = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x' },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(jwtish.statusCode).toBe(401);

      const badKey = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'x-api-key': 'plt_deadbeef.not-the-secret' },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(badKey.statusCode).toBe(401);

      const noSession = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'x-api-key': fullKey.token },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      });
      expect(noSession.statusCode).toBe(400);
      expect(noSession.json().error.message).toContain('Mcp-Session-Id');

      const unknownSession = await app.inject({
        method: 'GET',
        url: '/mcp',
        headers: { 'x-api-key': fullKey.token, 'mcp-session-id': 'not-a-real-session' },
      });
      expect(unknownSession.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// Last on purpose: closing the stdio server disconnects the shared Prisma client, and the
// suite has nothing left to run against it by then.
describe('stdio transport', () => {
  it('refuses to start without an API key, before touching anything', async () => {
    const { runStdioMcpServer, API_KEY_ENV } = await import('../stdio.js');
    delete process.env[API_KEY_ENV];
    await expect(runStdioMcpServer()).rejects.toThrow(/API key/i);
  });

  it('answers an initialize request on the streams it was given', async () => {
    const { PassThrough } = await import('node:stream');
    const { runStdioMcpServer } = await import('../stdio.js');

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = await runStdioMcpServer({
      apiKey: fullKey.token,
      logger: silentLogger(),
      stdin,
      stdout,
    });

    try {
      const firstLine = new Promise<string>((resolve) => {
        let buffer = '';
        stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const newline = buffer.indexOf('\n');
          if (newline >= 0) resolve(buffer.slice(0, newline));
        });
      });

      stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'stdio-agent', version: '1.0.0' },
          },
        })}\n`,
      );

      const response = JSON.parse(await firstLine) as {
        result: { serverInfo: { name: string }; instructions: string };
      };
      expect(response.result.serverInfo.name).toBe('platter');
      expect(response.result.instructions).toContain('You cannot install a mod');
    } finally {
      await handle.close();
    }
  }, 20_000);
});
