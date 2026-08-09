import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { NODE_DRIVERS } from '@platter/shared';

// .env is loaded before the schema runs so a file-provided value is indistinguishable
// from a real environment variable. Existing process env always wins (no override).
loadDotenv({ quiet: true });

/** `15m`, `30d`, `900s`, or a bare number of seconds. */
const DURATION_PATTERN = /^(\d+)\s*(ms|s|m|h|d|w)?$/i;

const DURATION_MULTIPLIERS: Record<string, number> = {
  ms: 1 / 1000,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

function parseDurationSeconds(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier = DURATION_MULTIPLIERS[unit];
  if (multiplier === undefined) return null;
  const seconds = Math.round(amount * multiplier);
  return seconds > 0 ? seconds : null;
}

const durationSchema = z
  .string()
  .refine((value) => parseDurationSeconds(value) !== null, 'Use a duration like 15m, 24h or 30d');

/** Accepts the spellings people actually type into a compose file. */
const booleanSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine(
    (value) => ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value),
    'Use true or false',
  )
  .transform((value) => ['true', '1', 'yes', 'on'].includes(value));

const portNumberSchema = z.coerce.number().int().min(1).max(65535);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HOST: z.string().min(1).default('0.0.0.0'),

    DATABASE_URL: z.string().min(1).default('file:./data/platter.db'),

    // Validated leniently here so development can self-heal below; production is checked
    // after parsing, where we can crash with an instruction instead of a schema error.
    JWT_SECRET: z.string().optional(),
    ACCESS_TOKEN_TTL: durationSchema.default('15m'),
    REFRESH_TOKEN_TTL: durationSchema.default('30d'),

    DATA_DIR: z.string().min(1).default('./data'),
    /**
     * Directory holding the built web client. The production image sets this; in
     * development it is absent and Vite serves the SPA instead, which is why an empty
     * value is legal rather than a startup error.
     */
    WEB_ROOT: z.string().default(''),
    BACKUP_DIR: z.string().min(1).default('./data/backups'),

    DOCKER_SOCKET: z.string().min(1).default('/var/run/docker.sock'),
    DEFAULT_NODE_DRIVER: z.enum(NODE_DRIVERS).default('docker'),
    PUBLIC_HOST: z.string().min(1).default('127.0.0.1'),
    PORT_RANGE_START: portNumberSchema.default(25000),
    PORT_RANGE_END: portNumberSchema.default(25999),

    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    AI_MODEL: z.string().min(1).default('claude-opus-5'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.string().default('false'),
    /** Comma-separated origins. Empty means "same origin only". */
    CORS_ORIGINS: z.string().default(''),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(300),
    REGISTRATION_ENABLED: booleanSchema.default(false),
    METRICS_ENABLED: booleanSchema.default(true),
  })
  .refine((env) => env.PORT_RANGE_END >= env.PORT_RANGE_START, {
    message: 'PORT_RANGE_END must be at or above PORT_RANGE_START',
    path: ['PORT_RANGE_END'],
  });

type Env = z.infer<typeof envSchema>;

function formatEnvIssues(error: z.ZodError<unknown>): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  ${key}: ${issue.message}`;
  });
  return ['Platter cannot start: the environment is not valid.', ...lines, '', 'See .env.example for every supported key.'].join(
    '\n',
  );
}

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Printed rather than thrown-with-stack: an operator debugging a compose file wants
    // the list of bad keys, not a v8 trace through zod.
    process.stderr.write(`${formatEnvIssues(result.error)}\n`);
    throw new Error('Invalid environment configuration');
  }
  return result.data;
}

const env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

const MIN_JWT_SECRET_LENGTH = 32;

function resolveJwtSecret(): string {
  const provided = env.JWT_SECRET?.trim();
  if (provided && provided.length >= MIN_JWT_SECRET_LENGTH) return provided;

  if (isProduction) {
    process.stderr.write(
      `Platter cannot start: JWT_SECRET must be set to at least ${MIN_JWT_SECRET_LENGTH} characters in production.\n` +
        'Generate one with: openssl rand -hex 32\n',
    );
    throw new Error('Invalid environment configuration');
  }

  // Ephemeral secret so a fresh checkout runs with no setup. Every restart invalidates
  // outstanding tokens, which is exactly why this is refused in production.
  const generated = randomBytes(32).toString('hex');
  process.stderr.write(
    provided
      ? `JWT_SECRET is shorter than ${MIN_JWT_SECRET_LENGTH} characters; using a random secret for this process. Sessions will not survive a restart.\n`
      : 'JWT_SECRET is not set; using a random secret for this process. Sessions will not survive a restart.\n',
  );
  return generated;
}

function parseTrustProxy(value: string): boolean | number | string {
  const normalised = value.trim().toLowerCase();
  if (normalised === '' || normalised === 'false' || normalised === 'no' || normalised === 'off') return false;
  if (normalised === 'true' || normalised === 'yes' || normalised === 'on') return true;
  const hops = Number(normalised);
  // A bare integer means "trust this many proxy hops"; anything else is a subnet list.
  if (Number.isInteger(hops) && hops >= 0) return hops;
  return value.trim();
}

const dataDir = path.resolve(process.cwd(), env.DATA_DIR);

export const config = Object.freeze({
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  host: env.HOST,

  databaseUrl: env.DATABASE_URL,

  jwtSecret: resolveJwtSecret(),
  accessTokenTtl: env.ACCESS_TOKEN_TTL,
  accessTokenTtlSeconds: parseDurationSeconds(env.ACCESS_TOKEN_TTL) ?? 900,
  refreshTokenTtl: env.REFRESH_TOKEN_TTL,
  refreshTokenTtlSeconds: parseDurationSeconds(env.REFRESH_TOKEN_TTL) ?? 2_592_000,

  /** Absolute; every path in the app is resolved against these, never against cwd. */
  dataDir,
  webRoot: env.WEB_ROOT === '' ? null : path.resolve(process.cwd(), env.WEB_ROOT),
  serversDir: path.join(dataDir, 'servers'),
  backupDir: path.resolve(process.cwd(), env.BACKUP_DIR),

  dockerSocket: env.DOCKER_SOCKET,
  defaultNodeDriver: env.DEFAULT_NODE_DRIVER,
  publicHost: env.PUBLIC_HOST,
  portRangeStart: env.PORT_RANGE_START,
  portRangeEnd: env.PORT_RANGE_END,

  anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
  aiModel: env.AI_MODEL,
  /** AI routes advertise themselves as unavailable rather than 500ing without a key. */
  aiEnabled: env.ANTHROPIC_API_KEY !== undefined,

  logLevel: env.LOG_LEVEL,
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  rateLimitMax: env.RATE_LIMIT_MAX,
  registrationEnabled: env.REGISTRATION_ENABLED,
  metricsEnabled: env.METRICS_ENABLED,
});

export type Config = typeof config;
