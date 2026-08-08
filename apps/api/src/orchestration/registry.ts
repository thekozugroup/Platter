import type { Node as NodeRow } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { NodeStatus } from '@platter/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { notFound } from '../lib/errors.js';
import { DockerDriver } from './docker.js';
import { MockDriver, isMockDriver } from './mock.js';
import type { OrchestrationDriver } from './driver.js';

/**
 * nodeId -> the driver that talks to it.
 *
 * Drivers are cached because they are not free: `DockerDriver` holds an agent pool to the
 * daemon and a container-id cache, and `MockDriver` holds simulated state that must not be
 * thrown away between two calls about the same server. They are keyed by a fingerprint of
 * everything about the node that changes what the driver *is*, so an operator editing a
 * node's endpoint gets a new driver on the next call instead of a stale connection to the
 * old address.
 */

interface CachedDriver {
  driver: OrchestrationDriver;
  fingerprint: string;
}

const drivers = new Map<string, CachedDriver>();

const DEFAULT_HEALTH_INTERVAL_MS = 30_000;
/** Floor for a caller-supplied interval: polling faster than this only costs the daemon. */
const MIN_HEALTH_INTERVAL_MS = 1000;

type DriverKind = 'docker' | 'mock';

/**
 * `DEFAULT_NODE_DRIVER=mock` is a hard override, not a default for new rows.
 *
 * It is the single switch that makes CI and the test suite incapable of reaching a real
 * Docker daemon: whatever a node row says, every driver handed out in that process is the
 * in-memory one. Getting this backwards — trusting the column first — would mean a seeded
 * `docker` node in a test run tries to start real containers.
 */
function effectiveKind(node: NodeRow): DriverKind {
  if (config.defaultNodeDriver === 'mock') return 'mock';
  // `NODE_DRIVERS` has exactly two members and the column is a plain string, so anything
  // unrecognised is treated as the real driver rather than silently simulated.
  return node.driver === 'mock' ? 'mock' : 'docker';
}

function fingerprintOf(node: NodeRow): string {
  return `${effectiveKind(node)} ${node.endpoint}`;
}

function instantiate(node: NodeRow): OrchestrationDriver {
  return effectiveKind(node) === 'mock'
    ? new MockDriver({ nodeId: node.id })
    : new DockerDriver({ nodeId: node.id, endpoint: node.endpoint });
}

/** Mock drivers own a timer; dropping one without disposing it leaks that timer. */
function release(driver: OrchestrationDriver): void {
  if (isMockDriver(driver)) driver.dispose();
}

/**
 * The driver for a node row the caller already has. Synchronous on purpose — the hot paths
 * (stats, console, the supervisor) hold the row and should not pay for a second lookup.
 */
export function getDriverForNode(node: NodeRow): OrchestrationDriver {
  const fingerprint = fingerprintOf(node);
  const cached = drivers.get(node.id);
  if (cached) {
    if (cached.fingerprint === fingerprint) return cached.driver;
    release(cached.driver);
  }

  const driver = instantiate(node);
  drivers.set(node.id, { driver, fingerprint });
  return driver;
}

export async function getDriver(nodeId: string): Promise<OrchestrationDriver> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound('node');
  return getDriverForNode(node);
}

/** Drops every cached driver. Called on shutdown, and between tests. */
export function resetDrivers(): void {
  for (const cached of drivers.values()) release(cached.driver);
  drivers.clear();
}

// ---------------------------------------------------------------------------
// Health polling
// ---------------------------------------------------------------------------

export interface HealthPollingOptions {
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

let timer: NodeJS.Timeout | null = null;
let polling = false;
let logger: FastifyBaseLogger | null = null;

/**
 * `health()` is contractually total, so the only failures reaching here are a bad endpoint
 * (the driver constructor rejects it) or the database write. Both mean "we do not know
 * this node is up", which is `offline` — a node stuck at `unknown` would keep receiving
 * placements from `selectNode`.
 */
async function probe(node: NodeRow): Promise<void> {
  let status: NodeStatus = 'offline';
  let version: string | null = null;
  let reachable = false;

  try {
    const health = await getDriverForNode(node).health();
    reachable = health.reachable;
    version = health.version;
    // A driver that answers *and* reports a problem is degraded rather than online: the
    // daemon is up but something about it is not, and an operator should see the
    // difference between "not responding" and "responding badly".
    status = !health.reachable ? 'offline' : health.error === null ? 'online' : 'degraded';
    if (!health.reachable && health.error !== null) {
      logger?.warn({ nodeId: node.id, reason: health.error }, 'node is not reachable');
    }
  } catch (error) {
    logger?.error({ err: error, nodeId: node.id }, 'node health probe failed');
  }

  try {
    await prisma.node.updateMany({
      where: { id: node.id },
      data: {
        status,
        // A node that has gone away keeps the last version we saw; blanking it would lose
        // the only record of what it was running.
        ...(version === null ? {} : { driverVersion: version }),
        ...(reachable ? { lastSeenAt: new Date() } : {}),
      },
    });
  } catch (error) {
    logger?.error({ err: error, nodeId: node.id }, 'could not record node health');
  }
}

/** One pass over every node. Never rejects: it is called from a timer. */
export async function pollHealthOnce(): Promise<void> {
  // A node that takes longer than the interval to answer must not let ticks pile up behind
  // it — in a daemon that runs for months that is how you get a thousand pending probes.
  if (polling) return;
  polling = true;
  try {
    const nodes = await prisma.node.findMany();
    await Promise.all(nodes.map(async (node) => probe(node)));
  } catch (error) {
    logger?.error({ err: error }, 'node health poll failed');
  } finally {
    polling = false;
  }
}

export function startHealthPolling(options: HealthPollingOptions = {}): void {
  if (timer) return;
  logger = options.logger ?? null;

  const intervalMs = Math.max(MIN_HEALTH_INTERVAL_MS, options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS);
  timer = setInterval(() => {
    void pollHealthOnce();
  }, intervalMs);
  // Health polling is telemetry; it must never be the reason the process stays alive.
  timer.unref();

  // Probe immediately so a freshly booted panel does not show every node as `unknown` for
  // the length of the first interval.
  void pollHealthOnce();
}

export function stopHealthPolling(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
