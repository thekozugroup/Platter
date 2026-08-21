import type { FastifyBaseLogger } from 'fastify';
import { closeAllRcon } from '../minecraft/rcon.js';
import { stopMdns } from '../net/mdns.js';
import { prisma } from '../db.js';
import { DockerDriver } from '../orchestration/docker.js';
import { recordMountCheck } from '../orchestration/mount-check.js';
import {
  getDriverForNode,
  resetDrivers,
  startHealthPolling,
  stopHealthPolling,
} from '../orchestration/registry.js';
import { ensureDefaultNode } from './nodes.js';
import { reconcile, startCrashSupervisor, stopCrashSupervisor } from './lifecycle.js';
import { startMetricsCollection, stopMetricsCollection } from './metrics.js';
import { startPlayerTracking, stopPlayerTracking } from './players.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import {
  closeTimeseriesDb,
  flushSamples,
  startTimeseriesMaintenance,
  stopTimeseriesMaintenance,
} from './timeseries.js';

/**
 * Everything Platter does when nobody is making a request.
 *
 * `buildApp` deliberately does not touch any of this: a test that injects a request wants
 * an HTTP surface, not a process that starts polling Docker, opening log streams and
 * writing to a metrics database. Boot order below is load-bearing — see the comments —
 * and `stopBackgroundServices` is the exact inverse, so a SIGTERM leaves nothing behind
 * that would keep the event loop alive.
 */

let started = false;

export async function startBackgroundServices(logger: FastifyBaseLogger): Promise<void> {
  if (started) return;
  started = true;

  // First, because everything downstream resolves a node: reconcile needs one to find
  // containers, and the allocator needs one to hand out ports. A fresh install has none.
  await ensureDefaultNode();

  // Before anything creates a container: if Platter and the daemon disagree about what a
  // path means, every file Platter writes for a server goes somewhere the server cannot
  // read, and nothing else in the system notices. Measured once, against the real daemon.
  await checkDataMount(logger);

  // Before reconcile, so the reconciler can already see which nodes answered. A node that
  // is unreachable is skipped rather than having all its servers declared dead.
  startHealthPolling({ logger });

  // The stored status is a claim about a machine that kept running while Platter was
  // down. This is what turns it back into a fact — and it must finish before the crash
  // supervisor starts, or the supervisor would count a container that died during the
  // outage as a crash that just happened.
  const result = await reconcile({ logger });
  logger.info(
    {
      checked: result.checked,
      corrected: result.corrected,
      started: result.started,
      resumed: result.resumed,
      orphans: result.orphans.length,
      unreachableNodes: result.unreachableNodes.length,
    },
    'reconciled servers against the runtime',
  );

  startCrashSupervisor({ logger });
  await startScheduler({ logger });
  startMetricsCollection({ logger });
  startTimeseriesMaintenance({ logger });
  startPlayerTracking({ logger });
}

/**
 * Unwinds the boot sequence. Ordered so nothing can schedule new work after its own
 * consumer has gone: timers stop first, then the buffered samples they produced are
 * flushed, then the sockets and handles close.
 */
export async function stopBackgroundServices(logger: FastifyBaseLogger): Promise<void> {
  if (!started) return;
  started = false;

  stopPlayerTracking();
  stopCrashSupervisor();
  stopScheduler();
  stopMetricsCollection();
  stopTimeseriesMaintenance();
  stopHealthPolling();

  // After the collectors have stopped, so the last interval's readings are not lost — the
  // buffer is in memory and would otherwise die with the process.
  try {
    await flushSamples();
  } catch (error) {
    logger.warn({ err: error }, 'could not flush buffered metric samples during shutdown');
  }

  closeTimeseriesDb();
  closeAllRcon();
  stopMdns();
  resetDrivers();
}

/**
 * Runs the data-mount proof against the default node's daemon and records the verdict.
 *
 * Never throws: a panel that refuses to boot is worse than one that boots and refuses to
 * provision, because the operator needs the UI to read the explanation.
 */
async function checkDataMount(logger: FastifyBaseLogger): Promise<void> {
  try {
    const node = await prisma.node.findFirst({ orderBy: { id: 'asc' } });
    if (!node) return;

    const driver = getDriverForNode(node);
    if (!(driver instanceof DockerDriver) || !driver.isLocal) {
      recordMountCheck({
        ok: true,
        skipped: true,
        reason: 'No local Docker driver to check.',
      });
      return;
    }

    const image = await driver.resolveProbeImage();
    if (image === null) {
      recordMountCheck({
        ok: true,
        skipped: true,
        reason: 'Could not determine an image to run the check with.',
      });
      logger.warn('skipping the data mount check: no probe image');
      return;
    }

    const result = await driver.checkDataMount(image, logger);
    recordMountCheck(result);

    if (!result.ok) {
      // Error, not warn: this is the difference between a working install and one that
      // silently loses every mod, config edit and backup.
      logger.error({ reason: result.reason, remedy: result.remedy }, 'data mount check FAILED');
    } else if (result.skipped) {
      logger.info({ reason: result.reason }, 'data mount check skipped');
    } else {
      logger.info('data mount check passed: Platter and the daemon agree on paths');
    }
  } catch (error) {
    logger.warn({ err: error }, 'the data mount check could not run');
  }
}
