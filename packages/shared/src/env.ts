import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Platter's configuration surface.
 *
 * Two rules govern what lives here:
 *   1. Everything has a working default. `pnpm dev` with an empty environment must produce a
 *      usable server, because a config file you have to fill in before anything works is the
 *      fastest way to lose someone in the first five minutes.
 *   2. Anything that widens the security posture has to be set deliberately, and the schema
 *      refuses to let you do it halfway (see the host/token cross-check at the bottom).
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
  );

const port = z.coerce.number().int().min(1).max(65_535);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /* --- Web server -------------------------------------------------------- */
    /** Bind address for the UI. Loopback by default; see SECURITY.md before changing. */
    PLATTER_HOST: z.string().default('127.0.0.1'),
    PLATTER_PORT: port.default(4880),
    /**
     * Shared secret for the UI and HTTP API. Optional on loopback, mandatory otherwise.
     * Compared with a timing-safe equality check.
     */
    PLATTER_AUTH_TOKEN: z.string().min(16).optional(),

    /* --- Storage ----------------------------------------------------------- */
    /**
     * Root for everything Platter writes: the SQLite database, per-server world data, backups
     * and the mod cache. One directory to back up, one directory to delete.
     */
    PLATTER_DATA_DIR: z.string().default(resolve(homedir(), '.platter')),

    /* --- Docker ------------------------------------------------------------ */
    /** Unix socket or tcp:// URL. Overridden by DOCKER_HOST if that is set. */
    PLATTER_DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
    DOCKER_HOST: z.string().optional(),
    /**
     * Docker network game containers join. Platter creates it if missing. A dedicated bridge
     * keeps game servers off the default bridge, where they can see every other container.
     */
    PLATTER_DOCKER_NETWORK: z.string().default('platter'),
    /** Allow images outside the curated manifest set. Off by default; see SECURITY.md. */
    PLATTER_ALLOW_CUSTOM_IMAGES: booleanish.default(false),

    /* --- Port allocation --------------------------------------------------- */
    /** Inclusive range Platter hands out host ports from, for game and query ports alike. */
    PLATTER_PORT_RANGE_START: port.default(25_565),
    PLATTER_PORT_RANGE_END: port.default(25_664),
    /** Interface published ports bind to on the host. 0.0.0.0 exposes servers to the LAN. */
    PLATTER_BIND_ADDRESS: z.string().default('0.0.0.0'),

    /* --- Mod providers ----------------------------------------------------- */
    /** Optional. Modrinth is usable anonymously; a token raises the rate limit. */
    MODRINTH_TOKEN: z.string().optional(),
    /** Required for any CurseForge feature. Without it Platter hides CurseForge entirely. */
    CURSEFORGE_API_KEY: z.string().optional(),

    /* --- MCP --------------------------------------------------------------- */
    PLATTER_MCP_PORT: port.default(4881),
    /**
     * Bearer token for the MCP HTTP transport. Generated on first run and written to
     * `$PLATTER_DATA_DIR/mcp-token` if unset. The stdio transport does not use it.
     */
    PLATTER_MCP_TOKEN: z.string().min(16).optional(),
    PLATTER_MCP_HOST: z.string().default('127.0.0.1'),

    /* --- Behaviour --------------------------------------------------------- */
    PLATTER_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** How many log lines Platter keeps in memory per server for the console view. */
    PLATTER_LOG_BUFFER_LINES: z.coerce.number().int().min(100).max(50_000).default(2000),
    /** Seconds between health/stat polls per running server. */
    PLATTER_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
    /** Disable the automatic pre-change backup taken before mod installs and rollbacks. */
    PLATTER_DISABLE_AUTO_BACKUP: booleanish.default(false),
    /** Skip Docker connectivity checks. Only useful in unit tests. */
    PLATTER_SKIP_DOCKER: booleanish.default(false),
  })
  .transform((env) => ({
    ...env,
    // A relative PLATTER_DATA_DIR is resolved against the working directory. The
    // `turbopackIgnore` comment stops Next's build tracer from concluding that this is dynamic
    // filesystem access and pulling the entire repository into the standalone output.
    PLATTER_DATA_DIR: isAbsolute(env.PLATTER_DATA_DIR)
      ? env.PLATTER_DATA_DIR
      : resolve(/* turbopackIgnore: true */ process.cwd(), env.PLATTER_DATA_DIR),
  }))
  .superRefine((env, ctx) => {
    if (env.PLATTER_PORT_RANGE_END < env.PLATTER_PORT_RANGE_START) {
      ctx.addIssue({
        code: 'custom',
        path: ['PLATTER_PORT_RANGE_END'],
        message: 'PLATTER_PORT_RANGE_END must be >= PLATTER_PORT_RANGE_START',
      });
    }

    // Binding the UI beyond loopback without a token would put container-level control of the
    // host on the network. Refuse at startup rather than discover it later.
    if (!LOOPBACK_HOSTS.has(env.PLATTER_HOST) && !env.PLATTER_AUTH_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['PLATTER_AUTH_TOKEN'],
        message:
          `PLATTER_HOST is "${env.PLATTER_HOST}", which is not loopback. ` +
          'Set PLATTER_AUTH_TOKEN (>= 16 chars) to expose Platter beyond this machine.',
      });
    }

    if (!LOOPBACK_HOSTS.has(env.PLATTER_MCP_HOST) && !env.PLATTER_MCP_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['PLATTER_MCP_TOKEN'],
        message:
          `PLATTER_MCP_HOST is "${env.PLATTER_MCP_HOST}", which is not loopback. ` +
          'Set PLATTER_MCP_TOKEN (>= 16 chars) to expose the MCP server beyond this machine.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Parse and memoise the environment. Throws a readable aggregate on failure — a misconfigured
 * Platter should say exactly which variable is wrong, not stack-trace out of a route handler.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) {
    return cached;
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid Platter configuration:\n${lines.join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test seam. Never call this from application code. */
export function resetEnvCache(): void {
  cached = undefined;
}

export const isLoopback = (host: string): boolean => LOOPBACK_HOSTS.has(host);
