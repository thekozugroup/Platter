import { Rcon } from 'rcon-client';
import { TIMEOUTS, type Result, fail, logger, ok } from '@platter/shared';

const log = logger.child('rcon');

/**
 * RCON — Platter's second control channel.
 *
 * Every existing panel drives Minecraft through the console: write to the container's stdin,
 * scrape stdout for the answer. That works until it doesn't. If a mod reconfigures log4j, the
 * scraping breaks. If the main thread wedges, the console stops echoing but the network thread
 * often still answers RCON. And "run a command and get its output back" is fundamentally a
 * request/response operation that a log tail can only approximate.
 *
 * More importantly, RCON is what makes a *hot backup* possible: `save-off` / `save-all flush` /
 * `save-on` is the only way to get a chunk-consistent copy of a world without stopping the
 * server, and it is the single biggest thing Platter does that PufferPanel and Crafty cannot.
 *
 * Connections are pooled per server. Minecraft's RCON implementation is single-threaded and
 * handles reconnection poorly under churn, so a connection per command — which is what the
 * obvious implementation does — causes visible tick lag on a busy server.
 */

export interface RconTarget {
  serverId: string;
  host: string;
  port: number;
  password: string;
}

interface PooledConnection {
  rcon: Rcon;
  /** Serialises commands: Minecraft's RCON does not tolerate pipelining. */
  chain: Promise<unknown>;
  lastUsed: number;
  /**
   * Commands currently executing or queued. The idle reaper checks this, because `lastUsed` is
   * only stamped when a command *finishes* — and `save-all flush` on a large modded world can
   * legitimately run for longer than the idle timeout.
   */
  inFlight: number;
}

const pool = new Map<string, PooledConnection>();

/**
 * Connections currently being established.
 *
 * Without this, two callers that miss the pool in the same tick both call `connect`, and the
 * second `pool.set` silently overwrites the first. The orphaned socket is then unreachable from
 * `closeRcon`, `closeAllRcon` and the reaper, so it stays open for the life of the process — and
 * the two callers run their commands on *different* connections with independent queues, which
 * is precisely the concurrent-RCON situation the serialisation below exists to prevent.
 */
const connecting = new Map<string, Promise<Result<PooledConnection>>>();

/**
 * How long a connection may sit unused before it is closed.
 *
 * Strictly greater than the longest command timeout Platter issues (`save-all flush`, at 120s),
 * so the reaper and a legitimate long-running command cannot be in a dead heat.
 */
const IDLE_TIMEOUT_MS = 300_000;

async function connect(target: RconTarget): Promise<Result<PooledConnection>> {
  try {
    const rcon = await Rcon.connect({
      host: target.host,
      port: target.port,
      password: target.password,
      timeout: TIMEOUTS.rconConnect,
    });

    const connection: PooledConnection = {
      rcon,
      chain: Promise.resolve(),
      lastUsed: Date.now(),
      inFlight: 0,
    };

    // A dropped connection must leave the pool, or every later command fails against a dead
    // socket until the process restarts.
    rcon.on('end', () => {
      if (pool.get(target.serverId) === connection) {
        pool.delete(target.serverId);
      }
    });
    rcon.on('error', (error: Error) => {
      log.debug('connection error', { serverId: target.serverId, error: error.message });
      if (pool.get(target.serverId) === connection) {
        pool.delete(target.serverId);
      }
    });

    pool.set(target.serverId, connection);
    return ok(connection);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    if (/authentication|password/i.test(message)) {
      return fail(
        'rcon_auth_failed',
        'RCON rejected the password. The container may be running with an older password — ' +
          'restart the server to re-apply it.',
        { details: { serverId: target.serverId }, cause }
      );
    }
    return fail(
      'rcon_unavailable',
      `Could not reach RCON on ${target.host}:${target.port}. The server may still be starting.`,
      { details: { serverId: target.serverId, port: target.port }, cause }
    );
  }
}

async function acquire(target: RconTarget): Promise<Result<PooledConnection>> {
  const existing = pool.get(target.serverId);
  if (existing) {
    existing.lastUsed = Date.now();
    return ok(existing);
  }

  // Share one in-flight connect between every caller that missed.
  const pending = connecting.get(target.serverId);
  if (pending) {
    return pending;
  }

  const attempt = connect(target).finally(() => connecting.delete(target.serverId));
  connecting.set(target.serverId, attempt);
  return attempt;
}

/**
 * Run a command and return its output.
 *
 * Commands are queued per server rather than issued concurrently. Minecraft's RCON matches
 * responses to requests by a sequential id and its implementation has historically mismatched
 * them under concurrency, which surfaces as one command receiving another's output — a
 * spectacularly confusing bug to chase from the UI side.
 */
export async function rconCommand(
  target: RconTarget,
  command: string,
  options: { timeoutMs?: number } = {}
): Promise<Result<string>> {
  const acquired = await acquire(target);
  if (!acquired.ok) {
    return acquired;
  }
  const connection = acquired.value;

  connection.inFlight++;

  const run = async (): Promise<Result<string>> => {
    try {
      const response = await withTimeout(
        connection.rcon.send(command),
        options.timeoutMs ?? TIMEOUTS.rconCommand,
        `RCON command "${command}" timed out`
      );
      connection.lastUsed = Date.now();
      return ok(response);
    } catch (cause) {
      pool.delete(target.serverId);
      try {
        await connection.rcon.end();
      } catch {
        // Already closed.
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return fail('rcon_unavailable', `RCON command failed: ${message}`, {
        details: { serverId: target.serverId, command },
        cause,
      });
    } finally {
      connection.inFlight--;
    }
  };

  const queued = connection.chain.then(run, run);
  // Keep the chain alive regardless of outcome so one failure does not wedge the queue.
  connection.chain = queued.catch(() => undefined);
  return queued;
}

export async function closeRcon(serverId: string): Promise<void> {
  const connection = pool.get(serverId);
  if (!connection) {
    return;
  }
  pool.delete(serverId);
  try {
    await connection.rcon.end();
  } catch {
    // Nothing useful to do if the socket is already gone.
  }
}

export async function closeAllRcon(): Promise<void> {
  await Promise.all([...pool.keys()].map(closeRcon));
}

/**
 * Drop connections nobody has used recently. Called by the supervisor tick.
 *
 * `inFlight` is checked as well as `lastUsed` because the two are not equivalent: `lastUsed` is
 * stamped when a command *completes*, so a `save-all flush` that legitimately runs for two
 * minutes on a large world looks idle the whole time it is working. Reaping it there kills the
 * socket mid-flush and fails a backup on a server that was perfectly healthy.
 */
export async function reapIdleRcon(now = Date.now()): Promise<void> {
  const stale = [...pool.entries()]
    .filter(([, connection]) => connection.inFlight === 0 && now - connection.lastUsed > IDLE_TIMEOUT_MS)
    .map(([serverId]) => serverId);
  await Promise.all(stale.map(closeRcon));
}

/* -------------------------------------------------------------------------- */
/* Higher-level operations                                                     */
/* -------------------------------------------------------------------------- */

export interface OnlinePlayers {
  online: number;
  max: number;
  names: string[];
}

const LIST_RE = /There are (?<online>\d+)(?: of a max(?: of)?| \/ )\s*(?<max>\d+)[^:]*:?\s*(?<names>.*)/s;

/**
 * Parse `/list`.
 *
 * The wording has changed across versions ("There are 1 of a max of 20 players online:" vs
 * "There are 1/20 players online:") and plugins rewrite it further, so the regex is deliberately
 * loose and the whole thing degrades to "unknown" rather than throwing. A player count is
 * decoration; it must never be able to fail a status poll.
 */
export function parsePlayerList(response: string): OnlinePlayers | undefined {
  const match = LIST_RE.exec(response.replace(/§[0-9a-fk-or]/gi, ''));
  if (!match?.groups) {
    return undefined;
  }
  const names = (match.groups.names ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return {
    online: Number(match.groups.online ?? 0),
    max: Number(match.groups.max ?? 0),
    names,
  };
}

export async function listPlayers(target: RconTarget): Promise<Result<OnlinePlayers>> {
  const response = await rconCommand(target, 'list');
  if (!response.ok) {
    return response;
  }
  const parsed = parsePlayerList(response.value);
  return parsed
    ? ok(parsed)
    : fail('upstream_error', 'Could not parse the player list response.', {
        details: { response: response.value },
      });
}

/**
 * Quiesce the world for a consistent snapshot.
 *
 * `save-off` stops the auto-save thread; `save-all flush` forces every dirty chunk to disk and,
 * critically, *waits* for the write to complete — plain `save-all` returns immediately and the
 * copy that follows catches a half-written region file. This is exactly the sequence Crafty's
 * own docs warn about not having ("compressing chunk data can lead to … chunk corruption").
 *
 * The caller MUST call `resumeSaves` afterwards, including on failure. Leaving auto-save off
 * means the world silently stops persisting until the next restart.
 */
export async function suspendSaves(target: RconTarget): Promise<Result<void>> {
  const off = await rconCommand(target, 'save-off');
  if (!off.ok) {
    return off;
  }
  const flush = await rconCommand(target, 'save-all flush', { timeoutMs: 120_000 });
  if (!flush.ok) {
    // Re-enable before surfacing the error; a failed flush must not leave saves disabled.
    await rconCommand(target, 'save-on').catch(() => undefined);
    return flush;
  }
  return ok(undefined);
}

export async function resumeSaves(target: RconTarget): Promise<Result<void>> {
  const result = await rconCommand(target, 'save-on');
  return result.ok ? ok(undefined) : result;
}

/** Broadcast a message to everyone on the server. */
export async function say(target: RconTarget, message: string): Promise<Result<string>> {
  return rconCommand(target, `say ${message}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
