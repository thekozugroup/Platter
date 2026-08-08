import { createSocket } from 'node:dgram';
import { connect, createServer, isIPv6 } from 'node:net';

/**
 * Reachability probing for a server's published port.
 *
 * This process can only ever prove what it can see from where it runs: whether something
 * local has actually bound the port, and whether a socket answers over whatever network
 * path this process has to the target. Neither proves the *internet* can reach it — that
 * needs a vantage point outside the LAN, which Platter does not have — so the strongest
 * result this module ever returns is "reachable on the LAN". Port forwarding is exactly
 * where most self-hosters get stuck, and pretending otherwise would send them looking for
 * a bug in the wrong place.
 */

const DEFAULT_TIMEOUT_MS = 2000;
/** Never bind to the well-known "probe" ports on the API host itself. */
const BIND_HOST = '0.0.0.0';

export type ProbeProtocol = 'tcp' | 'udp';

export interface ProbeTarget {
  /** The address a client would actually dial — the node's public host, not `0.0.0.0`. */
  host: string;
  port: number;
  protocol: ProbeProtocol;
  /** True when this process shares a network namespace with the container, so a local
   * bind attempt tests something real. False for a remote node, where binding this
   * process's own port says nothing about the other machine. */
  isLocalNode: boolean;
  timeoutMs?: number;
}

export type ReachabilityLevel = 'unreachable' | 'lan' | 'unknown';

export interface ProbeResult {
  host: string;
  port: number;
  protocol: ProbeProtocol;
  /** From the local bind test: `true` = something is bound (a good sign), `false` = the
   * port is free (nothing is listening), `null` = not checked because the node isn't
   * local to this process. */
  listening: boolean | null;
  /** A TCP connect, or a UDP send that drew an actual reply, succeeded. */
  connected: boolean;
  reachability: ReachabilityLevel;
  detail: string;
  latencyMs: number;
  checkedAt: string;
}

interface Outcome {
  /** `null` means genuinely inconclusive — only possible for UDP silence. */
  ok: boolean | null;
  detail: string;
}

// ---------------------------------------------------------------------------
// Local bind test
// ---------------------------------------------------------------------------

/** Resolves `true` when the port was free (bind succeeded, nothing was listening). */
function bindTcp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const settle = (free: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      server.removeAllListeners();
      server.close(() => undefined);
      resolve(free);
    };
    const guard = setTimeout(() => settle(false), timeoutMs);
    guard.unref();
    server.once('error', () => settle(false));
    server.once('listening', () => settle(true));
    server.listen({ host: BIND_HOST, port, exclusive: true });
  });
}

function bindUdp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: false });
    let settled = false;
    const settle = (free: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Never bound; nothing to close.
      }
      resolve(free);
    };
    const guard = setTimeout(() => settle(false), timeoutMs);
    guard.unref();
    socket.once('error', () => settle(false));
    socket.bind({ address: BIND_HOST, port, exclusive: true }, () => settle(true));
  });
}

/**
 * Whether the host will actually let something bind this port right now.
 *
 * Exported for `services/network.ts`'s manual port change: the database only knows about
 * ports Platter itself has handed out, so this is what catches a port already held by an
 * unrelated process before the operator finds out from a container that refuses to start.
 */
export function isPortFree(port: number, protocol: ProbeProtocol, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  return protocol === 'udp' ? bindUdp(port, timeoutMs) : bindTcp(port, timeoutMs);
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      socket.removeAllListeners();
      socket.destroy();
      resolve(outcome);
    };

    const guard = setTimeout(
      () => settle({ ok: false, detail: 'Timed out waiting for a response.' }),
      timeoutMs,
    );
    guard.unref();

    socket.once('connect', () => settle({ ok: true, detail: 'Accepted a TCP connection.' }));
    socket.once('error', (error) => {
      settle(
        errorCode(error) === 'ECONNREFUSED'
          ? { ok: false, detail: 'Connection refused — nothing is listening on this port.' }
          : { ok: false, detail: error.message },
      );
    });
  });
}

/**
 * UDP has no handshake, so silence within the timeout is not evidence of anything — a
 * perfectly healthy server that only replies to its own protocol looks identical to one
 * that is not running. Only two outcomes are conclusive: an actual reply, or the OS
 * delivering back a "port unreachable" as a socket error.
 */
function probeUdp(host: string, port: number, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = createSocket(isIPv6(host) ? 'udp6' : 'udp4');
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Already closed by the platform.
      }
      resolve(outcome);
    };

    const guard = setTimeout(
      () =>
        settle({
          ok: null,
          detail: 'No response within the timeout — normal for UDP even when the server is healthy.',
        }),
      timeoutMs,
    );
    guard.unref();

    socket.once('message', () => settle({ ok: true, detail: 'The server replied.' }));
    socket.once('error', (error) => {
      settle(
        errorCode(error) === 'ECONNREFUSED'
          ? { ok: false, detail: 'Connection refused — nothing is listening on this port.' }
          : { ok: null, detail: error.message },
      );
    });

    socket.send(Buffer.alloc(1), port, host, (error) => {
      if (error) settle({ ok: null, detail: error.message });
    });
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Runs the local bind test (when applicable) and then the real connectivity check.
 *
 * The bind test can only ever *shorten* the answer to "unreachable" — finding the port
 * free is conclusive — never lengthen it to "reachable". A bind failure only means
 * something is holding the port, not that it answers correctly, so the connect test still
 * has to run before this reports anything better than "unreachable".
 */
export async function probeAddress(target: ProbeTarget): Promise<ProbeResult> {
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();

  let listening: boolean | null = null;
  if (target.isLocalNode) {
    const free = await isPortFree(target.port, target.protocol, timeoutMs);
    listening = !free;
    if (free) {
      return {
        host: target.host,
        port: target.port,
        protocol: target.protocol,
        listening,
        connected: false,
        reachability: 'unreachable',
        detail: 'Nothing is listening on this port yet — the server may still be starting.',
        latencyMs: Date.now() - startedAt,
        checkedAt,
      };
    }
  }

  const outcome =
    target.protocol === 'tcp'
      ? await connectTcp(target.host, target.port, timeoutMs)
      : await probeUdp(target.host, target.port, timeoutMs);

  const reachability: ReachabilityLevel =
    outcome.ok === true ? 'lan' : outcome.ok === false ? 'unreachable' : 'unknown';

  return {
    host: target.host,
    port: target.port,
    protocol: target.protocol,
    listening,
    connected: outcome.ok === true,
    reachability,
    detail: outcome.detail,
    latencyMs: Date.now() - startedAt,
    checkedAt,
  };
}
