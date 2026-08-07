/**
 * A small structured logger.
 *
 * Platter runs as a local process whose output a human may actually read in a terminal, and as
 * an MCP stdio server whose stdout is a JSON-RPC channel that must not be polluted. Both cases
 * are handled here: everything goes to **stderr**, and the format switches between
 * human-readable and JSON.
 *
 * Writing to stdout from anywhere in this codebase will corrupt the MCP transport. That is the
 * entire reason this module exists rather than bare `console.log`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

export interface LoggerOptions {
  level?: LogLevel;
  /** Prefix identifying the subsystem, e.g. 'docker', 'mcp', 'mods'. */
  scope?: string;
  /** Force JSON output. Defaults to true when stderr is not a TTY. */
  json?: boolean;
  /** Injected for tests. */
  write?: (line: string) => void;
}

/** Keys whose values are replaced with `***` wherever they appear in log context. */
const REDACT_KEYS = new Set([
  'rconpassword',
  'password',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'secret',
  'platter_auth_token',
  'platter_mcp_token',
  'curseforge_api_key',
  'modrinth_token',
]);

/**
 * Recursively redact secrets. Applied to every log context object rather than left to call
 * sites, because the one call site that forgets is the one that ends up in a bug report
 * screenshot.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '***' : redact(val, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(scope: string): Logger;
  readonly level: LogLevel;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const scope = options.scope;
  const asJson = options.json ?? !process.stderr.isTTY;
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const threshold = LEVEL_ORDER[level];

  const emit = (entry: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[entry] < threshold) {
      return;
    }
    const safe = context ? (redact(context) as Record<string, unknown>) : undefined;

    if (asJson) {
      write(
        JSON.stringify({
          time: new Date().toISOString(),
          level: entry,
          scope,
          message,
          ...(safe ? { context: safe } : {}),
        })
      );
      return;
    }

    const time = new Date().toISOString().slice(11, 23);
    const tag = `${LEVEL_COLOR[entry]}${entry.toUpperCase().padEnd(5)}${RESET}`;
    const where = scope ? `${DIM}[${scope}]${RESET} ` : '';
    const extra = safe && Object.keys(safe).length > 0 ? ` ${DIM}${JSON.stringify(safe)}${RESET}` : '';
    write(`${DIM}${time}${RESET} ${tag} ${where}${message}${extra}`);
  };

  const logger: Logger = {
    level,
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: (childScope) =>
      createLogger({
        ...options,
        level,
        scope: scope ? `${scope}:${childScope}` : childScope,
      }),
  };

  return logger;
}

/** Default logger. Subsystems should call `.child('name')` rather than creating their own. */
export const logger = createLogger({
  level: (process.env.PLATTER_LOG_LEVEL as LogLevel | undefined) ?? 'info',
  scope: 'platter',
});
