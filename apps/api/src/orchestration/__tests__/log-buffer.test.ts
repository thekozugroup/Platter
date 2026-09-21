import { describe, expect, it } from 'vitest';
import type { DriverLogLine, LogStreamOptions, OrchestrationDriver } from '../driver.js';
import { LogHub } from '../log-buffer.js';

/**
 * The console's scrollback, and the two ways it used to be wrong.
 *
 * Both came from the same conflation: that a hub with a stream open is a hub that has the
 * server's history. It is not. The player tracker opens a stream on every boot with
 * `tail: 0` — it must, because replaying a join line would reopen a session for somebody
 * who left hours ago — and `attach` is idempotent, so a console opening afterwards joined
 * a stream carrying no history and asked for none. On a server that had been quiet since
 * Platter last restarted, the pane said "Waiting for output. Nothing has been logged yet."
 * about a server with a full log file.
 *
 * The other direction was just as visible: a hub whose ring already held the scrollback
 * replayed the same tail from the daemon on every reopen, printing the history underneath
 * itself once per visit.
 */

interface FakeDriverOptions {
  /** What the container has already written, oldest first. */
  history?: DriverLogLine[];
}

/**
 * The smallest driver that can answer both questions the hub asks.
 *
 * Hand-written rather than `MockDriver` because what is under test is the *arguments* the
 * hub passes — whether it asks for a tail or for what happened since — and a fake that
 * records them states that directly.
 */
class FakeDriver {
  readonly calls: LogStreamOptions[] = [];
  private readonly history: DriverLogLine[];
  /** Resolves once a follow stream is actually being consumed, so a test can await it. */
  private following: (() => void) | null = null;

  constructor(options: FakeDriverOptions = {}) {
    this.history = options.history ?? [];
  }

  streamLogs(_serverId: string, options: LogStreamOptions = {}): AsyncIterable<DriverLogLine> {
    this.calls.push(options);
    const history = this.history;
    const since = options.since?.getTime() ?? null;
    const follow = options.follow !== false;
    const markFollowing = (): void => {
      const notify = this.following;
      this.following = null;
      notify?.();
    };

    return {
      async *[Symbol.asyncIterator]() {
        for (const line of history) {
          if (since !== null && line.timestamp.getTime() <= since) continue;
          yield line;
        }
        if (!follow) return;
        // A follow stream stays open. Nothing else arrives in these tests; the point is
        // that it does not end, so `attached` stays true the way a real one does.
        markFollowing();
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
  }

  asDriver(): OrchestrationDriver {
    return this as unknown as OrchestrationDriver;
  }
}

function line(seconds: number, content: string): DriverLogLine {
  return {
    stream: 'stdout',
    content,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)),
  };
}

const HISTORY = [line(1, 'Starting minecraft server'), line(2, 'Preparing level'), line(3, 'Done')];

describe('a hub attached without history', () => {
  /**
   * The reported bug, in one test: Platter restarts, the player tracker attaches with no
   * history, and the operator opens a console. Before `hydrate` existed this asserted an
   * empty backlog, which is what the pane showed.
   */
  it('can still be caught up, which is what the console needs', async () => {
    const driver = new FakeDriver({ history: HISTORY });
    const hub = new LogHub('srv_quiet');

    // What `startTracker` does on boot: follow, but replay nothing.
    hub.attach({ driver: driver.asDriver(), tail: 0 });
    expect(hub.attached).toBe(true);
    expect(hub.backlog()).toHaveLength(0);

    await hub.hydrate(driver.asDriver());

    expect(hub.backlog().map((entry) => entry.content)).toEqual([
      'Starting minecraft server',
      'Preparing level',
      'Done',
    ]);
    hub.detach();
  });

  it('reads the history once, however many consoles open at the same moment', async () => {
    const driver = new FakeDriver({ history: HISTORY });
    const hub = new LogHub('srv_busy');

    await Promise.all([hub.hydrate(driver.asDriver()), hub.hydrate(driver.asDriver())]);

    const reads = driver.calls.filter((call) => call.follow === false);
    expect(reads).toHaveLength(1);
    expect(hub.backlog()).toHaveLength(3);
  });

  it('asks for history as a one-shot read, never a second follow stream', async () => {
    const driver = new FakeDriver({ history: HISTORY });
    const hub = new LogHub('srv_oneshot');

    await hub.hydrate(driver.asDriver());

    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]?.follow).toBe(false);
  });

  it('does not print a line twice when the live stream already delivered it', async () => {
    const driver = new FakeDriver({ history: HISTORY });
    const hub = new LogHub('srv_overlap');

    // The newest history line arrived live before anybody asked for the history.
    hub.append({ stream: 'stdout', content: 'Done', timestamp: HISTORY[2]!.timestamp });

    await hub.hydrate(driver.asDriver());

    const contents = hub.backlog().map((entry) => entry.content);
    expect(contents).toEqual(['Starting minecraft server', 'Preparing level', 'Done']);
    expect(contents.filter((entry) => entry === 'Done')).toHaveLength(1);
  });

  it('renumbers so the backlog reads oldest first after history is put in front', async () => {
    const driver = new FakeDriver({ history: HISTORY });
    const hub = new LogHub('srv_order');

    hub.append({ stream: 'stdout', content: 'A player joined', timestamp: line(9, '').timestamp });
    await hub.hydrate(driver.asDriver());

    const backlog = hub.backlog();
    expect(backlog.map((entry) => entry.content)).toEqual([
      'Starting minecraft server',
      'Preparing level',
      'Done',
      'A player joined',
    ]);
    expect(backlog.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe('reattaching a hub that already has scrollback', () => {
  /**
   * The duplication half. A console closing detaches the stream and the ring survives, so
   * the next open must ask for what happened *since* the newest line rather than replaying
   * a tail it is already holding.
   */
  it('resumes from the newest line instead of replaying the tail', async () => {
    const driver = new FakeDriver({ history: HISTORY });
    const hub = new LogHub('srv_reopen');

    await hub.hydrate(driver.asDriver());
    hub.attach({ driver: driver.asDriver() });
    hub.detach();
    hub.attach({ driver: driver.asDriver() });

    const follows = driver.calls.filter((call) => call.follow !== false);
    expect(follows).toHaveLength(2);
    for (const call of follows) {
      expect(call.since, 'a reattach must resume, not replay').toBeInstanceOf(Date);
      expect(call.since?.toISOString()).toBe(HISTORY[2]!.timestamp.toISOString());
    }

    hub.detach();
    expect(hub.backlog().map((entry) => entry.content)).toEqual([
      'Starting minecraft server',
      'Preparing level',
      'Done',
    ]);
  });

  it('asks for a tail on a cold hub, where there is nothing to resume from', () => {
    const driver = new FakeDriver({ history: HISTORY });
    const hub = new LogHub('srv_cold');

    hub.attach({ driver: driver.asDriver() });

    expect(driver.calls[0]?.since).toBeUndefined();
    expect(driver.calls[0]?.tail).toBeGreaterThan(0);
    hub.detach();
  });
});
