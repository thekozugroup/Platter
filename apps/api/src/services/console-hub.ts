import type { FastifyBaseLogger } from 'fastify';
import { ACTIVE_SERVER_STATUSES, type LogLine, type ServerStats, type ServerStatus } from '@platter/shared';
import { prisma } from '../db.js';
import { getLogHub, type LogHub, type LogHubEvent } from '../orchestration/log-buffer.js';
import { getDriver } from '../orchestration/registry.js';
import type { ServerRecord } from '../plugins/auth.js';
import { findBlueprint, getServerStats, presentStatus } from './servers.js';

/**
 * What sits between one server's `LogHub` and the sockets watching it.
 *
 * The hub already fans out lines and status transitions, so this exists for the two
 * things it cannot do: sample stats on a timer, and notice that the server row has gone
 * away. Both are per-server rather than per-socket — ten people watching one console must
 * not mean ten stats calls against the driver — so there is exactly one channel per
 * server, and the last socket to leave tears it down.
 */

/** One socket per tab, a couple of tabs, a stale reconnect or two. Beyond that is a bug. */
export const MAX_CONSOLE_SOCKETS_PER_USER = 6;

/** Scrollback handed to a socket the moment it authenticates. */
export const DEFAULT_BACKLOG_LINES = 200;

/**
 * One timer does three jobs: refresh the row the stats sampler needs, notice a deletion,
 * and catch the status changes that do not go through the lifecycle service (suspension
 * is a column, not a transition). Live transitions arrive from the hub in between.
 */
const SAMPLE_INTERVAL_MS = 5_000;

export interface ConsoleSubscriber {
  onLog(line: LogLine): void;
  onStatus(status: ServerStatus, exitCode: number | null): void;
  onStats(stats: ServerStats): void;
  /** The server row disappeared underneath us — the socket should close, not retry. */
  onGone(): void;
}

export interface ConsoleAttachment {
  /**
   * Scrollback captured in the same tick as the subscription, so a socket sees every line
   * exactly once: nothing is lost between the snapshot and the first live frame, and
   * nothing arrives twice.
   */
  readonly initialBacklog: LogLine[];
  backlog(limit: number): LogLine[];
  detach(): void;
}

const channels = new Map<string, ServerChannel>();
const consoleSlots = new Map<string, number>();

class ServerChannel {
  readonly #serverId: string;
  readonly #log: FastifyBaseLogger;
  readonly #hub: LogHub;
  readonly #subscribers = new Set<ConsoleSubscriber>();

  #row: ServerRecord;
  #status: ServerStatus;
  #exitCode: number | null;

  #unsubscribe: (() => void) | null = null;
  #timer: NodeJS.Timeout | null = null;
  #sampling = false;
  #openingStream = false;
  #statsFailing = false;
  #disposed = false;

  constructor(server: ServerRecord, log: FastifyBaseLogger) {
    this.#serverId = server.id;
    this.#log = log;
    this.#hub = getLogHub(server.id);
    this.#row = server;
    this.#status = presentStatus(server);
    this.#exitCode = server.lastExitCode;
  }

  attach(subscriber: ConsoleSubscriber): ConsoleAttachment {
    this.#subscribers.add(subscriber);

    // Subscribing and snapshotting the scrollback happen in one tick, with no await
    // between them, which is what makes "no gap and no duplicate" true rather than likely.
    this.#unsubscribe ??= this.#hub.subscribe(this.#onHubEvent);
    const initialBacklog = this.#hub.backlog(DEFAULT_BACKLOG_LINES);

    if (this.#timer === null) {
      this.#timer = setInterval(() => {
        void this.#sample();
      }, SAMPLE_INTERVAL_MS);
      // A console nobody is watching must never be the reason the process stays alive.
      this.#timer.unref();
    }

    // Not awaited: opening the driver stream involves a round trip to the node, and the
    // socket should get its scrollback and its `ready` frame without waiting for it.
    void this.#ensureStream();

    let detached = false;
    return {
      initialBacklog,
      backlog: (limit: number) => this.#hub.backlog(limit),
      detach: () => {
        if (detached) return;
        detached = true;
        this.#subscribers.delete(subscriber);
        if (this.#subscribers.size === 0) this.#dispose();
      },
    };
  }

  /** Bound field, not a method: it is handed to `subscribe` and must keep its `this`. */
  readonly #onHubEvent = (event: LogHubEvent): void => {
    switch (event.type) {
      case 'line':
        this.#broadcast((subscriber) => {
          subscriber.onLog(event.line);
        });
        return;
      case 'status':
        this.#applyStatus(event.status, event.exitCode);
        return;
      // `ready` and `crash` re-announce a line that was already delivered as `line`;
      // forwarding them would show the operator the same output twice.
      case 'ready':
      case 'crash':
        return;
    }
  };

  /**
   * Opens the single driver stream when a console is the first thing to want it.
   *
   * The hub drops its stream as soon as its last listener leaves, so a server that has
   * been running since before this process started — or since the last console closed —
   * has no live output until somebody asks for it. `LogHub.attach` is idempotent, so
   * racing the lifecycle service here is harmless.
   */
  async #ensureStream(): Promise<void> {
    if (this.#disposed || this.#openingStream || this.#hub.attached) return;
    if (!ACTIVE_SERVER_STATUSES.includes(this.#status)) return;

    this.#openingStream = true;
    try {
      const driver = await getDriver(this.#row.nodeId);
      const blueprint = await findBlueprint(this.#row.blueprintKey, this.#log);
      if (this.#disposed || this.#hub.attached) return;
      // Replay from the runtime only when the ring is empty. Asking for a tail we already
      // hold would deliver those lines to every watcher a second time.
      const tail = this.#hub.backlog(1).length === 0 ? DEFAULT_BACKLOG_LINES : 0;
      this.#hub.attach({
        driver,
        tail,
        ...(blueprint ? { signals: blueprint.signals } : {}),
      });
    } catch (error) {
      this.#log.warn({ err: error, serverId: this.#serverId }, 'could not open the console stream');
    } finally {
      this.#openingStream = false;
    }
  }

  async #sample(): Promise<void> {
    if (this.#sampling || this.#disposed || this.#subscribers.size === 0) return;
    this.#sampling = true;
    try {
      const row = await prisma.server.findUnique({ where: { id: this.#serverId } });
      if (this.#disposed) return;
      if (!row) {
        this.#broadcast((subscriber) => {
          subscriber.onGone();
        });
        this.#dispose();
        return;
      }
      this.#row = row;
      this.#applyStatus(presentStatus(row), row.lastExitCode);
      await this.#ensureStream();

      // Sampling a container that is not running is a round trip to the node that can only
      // produce an all-zero frame.
      if (this.#status !== 'running' || this.#disposed) return;

      const stats = await getServerStats(row);
      if (this.#disposed) return;
      this.#statsFailing = false;
      this.#broadcast((subscriber) => {
        subscriber.onStats(stats);
      });
    } catch (error) {
      // Logged once per failing streak: a node that goes away would otherwise write a line
      // every five seconds for as long as one console stays open.
      if (!this.#statsFailing) {
        this.#statsFailing = true;
        this.#log.warn({ err: error, serverId: this.#serverId }, 'console sample failed');
      }
    } finally {
      this.#sampling = false;
    }
  }

  #applyStatus(status: ServerStatus, exitCode: number | null): void {
    if (status === this.#status && exitCode === this.#exitCode) return;
    this.#status = status;
    this.#exitCode = exitCode;
    this.#broadcast((subscriber) => {
      subscriber.onStatus(status, exitCode);
    });
  }

  #broadcast(deliver: (subscriber: ConsoleSubscriber) => void): void {
    for (const subscriber of this.#subscribers) {
      try {
        deliver(subscriber);
      } catch (error) {
        // One socket failing to accept a frame must not cost the others the rest of it.
        this.#log.warn({ err: error, serverId: this.#serverId }, 'console subscriber threw');
      }
    }
  }

  #dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;

    // Releasing the last subscription is also what tells the hub to close the driver
    // stream, so forgetting this leaks a `docker logs --follow` per console ever opened.
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#subscribers.clear();

    // Evicted under its own identity only: a channel recreated while this one was tearing
    // down must not be removed by our teardown.
    if (channels.get(this.#serverId) === this) channels.delete(this.#serverId);
  }

  dispose(): void {
    this.#dispose();
  }
}

/**
 * Synchronous on purpose. Everything a socket needs to start reading — the subscription
 * and the scrollback snapshot — is in memory, and doing it without an await is what makes
 * the no-gap guarantee above structural rather than a matter of timing.
 */
export function attachServerConsole(
  server: ServerRecord,
  subscriber: ConsoleSubscriber,
  log: FastifyBaseLogger,
): ConsoleAttachment {
  let channel = channels.get(server.id);
  if (!channel) {
    channel = new ServerChannel(server, log);
    channels.set(server.id, channel);
  }
  return channel.attach(subscriber);
}

/**
 * Per-principal socket budget. Returns the release function, or null when the budget is
 * spent — the caller closes with `WS_CLOSE.tooManyConnections` rather than queueing.
 */
export function acquireConsoleSlot(userId: string): (() => void) | null {
  const inUse = consoleSlots.get(userId) ?? 0;
  if (inUse >= MAX_CONSOLE_SOCKETS_PER_USER) return null;
  consoleSlots.set(userId, inUse + 1);

  let released = false;
  return () => {
    // Idempotent: teardown runs from the close handler and from the error path.
    if (released) return;
    released = true;
    const remaining = (consoleSlots.get(userId) ?? 1) - 1;
    if (remaining <= 0) consoleSlots.delete(userId);
    else consoleSlots.set(userId, remaining);
  };
}

/** Drops every channel's timer and subscription. Called from the server's `preClose`. */
export function closeConsoleHub(): void {
  for (const channel of [...channels.values()]) channel.dispose();
  channels.clear();
  consoleSlots.clear();
}
