import { formatMiB, recommendMemory } from '../memory';
import type { Fix, Match, MatchContext, Rule } from '../types';
import { candidateBlocks, detailNumber, detailString, match } from './helpers';

/**
 * Everything between the mod loader and the machine: ports, disks, file ownership, downloads,
 * a wedged tick loop, and a server that looks healthy but is not.
 *
 * These share a property that makes them worth grouping — none of them are the user's fault in
 * the way a bad mod list is, and several of them are invisible from inside the game. A server
 * that is paused reports healthy. A server that failed to download its own jar never writes a
 * Minecraft log line at all. If Platter only looked at Minecraft's output it would report
 * "nothing wrong" for both.
 */

/* -------------------------------------------------------------------------- */
/* Port already in use                                                         */
/* -------------------------------------------------------------------------- */

/** The banner vanilla prints. On its own it says a bind failed, but not why. */
const BIND_BANNER_RE = /FAILED TO BIND TO PORT/;

/** The cause. This is the one that actually means "something else has the port". */
const ADDRESS_IN_USE_RE = /BindException: Address already in use/;

/**
 * A different bind failure that prints the same banner: the configured address does not exist
 * on this host. Moving to another port would not help, so it must not be confused with a
 * conflict. Vanilla logs the banner and the cause as two separate records, which is why the
 * decision needs a window rather than a single block.
 */
const WRONG_ADDRESS_RE = /BindException: Cannot assign requested address/;

const PORT_RE = /Starting Minecraft server on (?:[^:\r\n]{0,64}):(?<port>\d{1,5})/;

/** How many following records to read when deciding what a banner meant. */
const BIND_CONTEXT_BLOCKS = 3;

export const portInUse: Rule = {
  id: 'network.port-in-use',
  title: 'Another program is already using the server’s port',
  severity: 'critical',
  category: 'network',
  hints: ['failed to bind to port', 'address already in use'],

  match(ctx: MatchContext): Match | null {
    const blocks = candidateBlocks(ctx.blocks);
    for (const [i, block] of blocks.entries()) {
      const banner = BIND_BANNER_RE.test(block.text);
      if (!banner && !ADDRESS_IN_USE_RE.test(block.text)) {
        continue;
      }

      // Read the banner together with the records that follow it, because the reason lives there.
      const window = blocks
        .slice(i, i + BIND_CONTEXT_BLOCKS + 1)
        .map((b) => b.text)
        .join('\n');

      if (WRONG_ADDRESS_RE.test(window) && !ADDRESS_IN_USE_RE.test(window)) {
        continue;
      }
      // A bare banner with no cause anywhere nearby is not enough to claim a port conflict.
      if (banner && !ADDRESS_IN_USE_RE.test(window)) {
        continue;
      }

      const port = ctx.blocks
        .map((b) => PORT_RE.exec(b.text)?.groups?.port)
        .find((p) => p !== undefined);
      return match([block], 'high', { ...(port === undefined ? {} : { port: Number(port) }) });
    }
    return null;
  },

  explain(m: Match): string {
    const port = detailNumber(m, 'port', 0);
    const which = port > 0 ? `port ${port}` : 'the port it was given';
    return (
      `The server could not claim ${which} because something else is already listening on it. ` +
      `That is usually another Minecraft server — including an earlier copy of this one that has ` +
      `not fully shut down yet. Nothing is wrong with the server itself; it simply had nowhere to ` +
      `accept connections.`
    );
  },

  fixes(): Fix[] {
    return [
      {
        id: 'reallocate-port',
        title: 'Move this server to a free port',
        detail:
          'Picks a port nothing else is using and restarts. Players will need the new address, ' +
          'which Platter will show you once the server is up.',
        kind: 'automatic',
        action: { type: 'reallocate_port' },
        confidence: 'high',
      },
      {
        id: 'stop-other-server',
        title: 'Stop whatever else is using the port',
        detail:
          'If an older copy of this server is still running, stopping it frees the port and keeps ' +
          'the address your players already have.',
        kind: 'manual',
        confidence: 'medium',
        supersededBy: ['reallocate_port'],
      },
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* World and chunk corruption                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Damage at the storage layer. These name the file format itself rather than any game concept,
 * which is what separates real corruption from an ordinary mod crash that happens to occur
 * during world tick.
 */
const STORAGE_DAMAGE_RE =
  /Chunk file at .{0,40} is missing header data|is truncated: expected .{0,60} but read|Failed to save chunk|Failed to load chunk|Region file .{0,120} (?:is )?(?:truncated|corrupt)|ChunkStorage|Invalid chunk coordinate|Failed to load level|Exception initializing level|Failed to read chunk/;

/**
 * Present in almost every modded crash and, on its own, almost never corruption. It is treated
 * as evidence only when something at the storage layer agrees, or when the server actually died
 * — otherwise this rule would fire on every server with a buggy mob and tell people to restore
 * a backup they do not need.
 */
const TICK_EXCEPTION_RE = /Exception ticking world|Exception in server tick loop/;

const CHUNK_FRAME_RE = /ChunkHolder|ChunkMap|SectionStorage|RegionFile|RegionFileStorage/;

export const worldCorruption: Rule = {
  id: 'world.corruption',
  title: 'Part of the world could not be read or written',
  severity: 'critical',
  category: 'world',
  hints: [
    'missing header data',
    'failed to save chunk',
    'failed to load chunk',
    'failed to read chunk',
    'regionfile',
    'chunkstorage',
    'failed to load level',
    'exception ticking world',
    'exception in server tick loop',
  ],

  match(ctx: MatchContext): Match | null {
    const exited = ctx.exitCode !== undefined && ctx.exitCode !== 0;

    for (const block of candidateBlocks(ctx.blocks)) {
      if (STORAGE_DAMAGE_RE.test(block.text)) {
        return match([block], 'high', { signal: 'storage' });
      }
    }

    // Second pass, deliberately weaker: a tick failure only counts when the chunk system is in
    // the trace *and* the server did not survive it.
    for (const block of candidateBlocks(ctx.blocks)) {
      if (TICK_EXCEPTION_RE.test(block.text) && CHUNK_FRAME_RE.test(block.text) && exited) {
        return match([block], 'low', { signal: 'tick' });
      }
    }
    return null;
  },

  explain(m: Match): string {
    if (detailString(m, 'signal') === 'tick') {
      return (
        'The server hit an error while updating the world and stopped. The chunk system is ' +
        'involved, which can mean damaged world files — but a misbehaving mod produces a very ' +
        'similar failure, and that is the more common explanation. Treat this as a lead rather ' +
        'than a conclusion: check the log for a mod name before restoring anything.'
      );
    }
    return (
      'The server could not read or write part of the world on disk. Minecraft stores the world ' +
      'in large files that each hold hundreds of chunks, so damage to one file affects a whole ' +
      'region of the map rather than a single spot. The usual cause is the server being cut off ' +
      'part-way through saving — a power loss, or a shutdown that was not given time to finish.'
    );
  },

  fixes(m: Match): Fix[] {
    const weak = detailString(m, 'signal') === 'tick';
    const fixes: Fix[] = [];

    if (weak) {
      fixes.push({
        id: 'identify-mod',
        title: 'Check which mod was involved',
        detail:
          'Look at the lines just above the error for a mod name. If one appears, updating or ' +
          'removing that mod is far less disruptive than restoring a backup.',
        kind: 'manual',
        confidence: 'medium',
      });
    }

    fixes.push({
      id: 'restore-backup',
      title: 'Restore the most recent backup',
      detail:
        'Replaces the world with the last good copy. Anything built since that backup was taken ' +
        'is lost, so Platter takes a snapshot of the current state first — you can always come ' +
        'back to it.',
      kind: 'automatic',
      action: { type: 'restore_backup' },
      confidence: weak ? 'low' : 'high',
    });

    if (!weak) {
      fixes.push({
        id: 'accept-chunk-loss',
        title: 'Let the server regenerate the damaged area',
        detail:
          'Minecraft rebuilds unreadable chunks from scratch on next visit. Terrain returns, but ' +
          'anything players built there does not. Sensible only if the damage is somewhere remote.',
        kind: 'manual',
        confidence: 'low',
        supersededBy: ['restore_backup'],
      });
    }

    return fixes;
  },
};

/* -------------------------------------------------------------------------- */
/* Watchdog                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The watchdog is a timer, not a crash detector. If one game tick takes longer than
 * `max-tick-time` it assumes the server is wedged and kills it — which is usually right, but is
 * also exactly what happens when a server is deliberately paused, or when the host went to
 * sleep. Distinguishing "hung" from "was stopped for a while" is the whole job here.
 */
const WATCHDOG_TICK_RE = /A single server tick took (?<seconds>[\d.]{1,12}) seconds/;
const WATCHDOG_KILL_RE = /Considering it to be crashed, server will forcibly shutdown/;
const WATCHDOG_PAPER_RE = /The server has stopped responding!/;

/** Ordinary lag. Logged constantly on busy servers and means nothing on its own. */
const CANT_KEEP_UP_RE = /Can't keep up! Did the system time change, or is the server overloaded/;

export const watchdogTimeout: Rule = {
  id: 'startup.watchdog-timeout',
  title: 'The server stopped responding and was shut down',
  severity: 'error',
  category: 'startup',
  hints: [
    'a single server tick took',
    'considering it to be crashed',
    'the server has stopped responding',
  ],

  match(ctx: MatchContext): Match | null {
    for (const block of candidateBlocks(ctx.blocks)) {
      const killed = WATCHDOG_KILL_RE.test(block.text) || WATCHDOG_PAPER_RE.test(block.text);
      const tick = WATCHDOG_TICK_RE.exec(block.text);
      // Lag alone is not a watchdog kill. Requiring the kill line keeps this rule off the
      // thousands of servers that log "Can't keep up!" every evening and are perfectly fine.
      if (!killed && tick === null) {
        continue;
      }
      if (!killed && CANT_KEEP_UP_RE.test(block.text)) {
        continue;
      }
      const seconds = tick?.groups?.seconds;
      return match([block], killed ? 'high' : 'medium', {
        ...(seconds === undefined ? {} : { seconds: Number(seconds) }),
        autopause: ctx.server.autopauseEnabled === true,
      });
    }
    return null;
  },

  explain(m: Match): string {
    const seconds = detailNumber(m, 'seconds', 0);
    const autopause = m.details.autopause === true;
    const howLong =
      seconds > 0
        ? `A single moment of game time took ${formatSeconds(seconds)} instead of the usual ` +
          `twentieth of a second`
        : 'The server stopped making progress';

    if (autopause) {
      return (
        `${howLong}, so the safety timer shut the server down. This server has automatic pausing ` +
        `switched on, and pausing looks identical to a freeze from the timer's point of view — so ` +
        `this is very likely the pause being mistaken for a fault rather than a real problem.`
      );
    }
    return (
      `${howLong}, so the safety timer shut the server down to avoid damaging the world. The ` +
      `server was alive but stuck: something it was doing never finished. Common causes are a ` +
      `mod caught in a loop, a huge number of entities in one place, or the server running out ` +
      `of memory and spending all its time clearing up.`
    );
  },

  fixes(m: Match): Fix[] {
    const autopause = m.details.autopause === true;
    if (autopause) {
      return [
        {
          id: 'disable-watchdog-for-autopause',
          title: 'Turn off the freeze timer',
          detail:
            'Automatic pausing and the freeze timer cannot both be on — pausing always looks like ' +
            'a freeze. Turning the timer off is the documented way to run with pausing enabled.',
          kind: 'automatic',
          action: { type: 'set_setting', key: 'MAX_TICK_TIME', value: '-1' },
          confidence: 'high',
        },
      ];
    }
    return [
      {
        id: 'investigate-hang',
        title: 'Find what the server was doing when it froze',
        detail:
          'The log records what every part of the server was busy with at the moment it was ' +
          'stopped. A mod name appearing there is your culprit.',
        kind: 'manual',
        confidence: 'high',
      },
      {
        id: 'raise-tick-limit',
        title: 'Give the server longer before the timer fires',
        detail:
          'Raises the freeze threshold to five minutes. This hides the symptom rather than fixing ' +
          'the cause, and is worth doing only while you investigate.',
        kind: 'automatic',
        action: { type: 'set_setting', key: 'MAX_TICK_TIME', value: '300000' },
        confidence: 'low',
      },
    ];
  },
};

function formatSeconds(seconds: number): string {
  if (seconds < 120) {
    return `${seconds} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

/** The image's own message, emitted by `writeEula` when `/data` is not writable. */
const ITZG_PERMISSION_RE =
  /Unable to write eula to \/data\. Please make sure attached directory is writable by uid=(?<uid>\d{1,7})/;

const JAVA_PERMISSION_RE =
  /(?:java\.nio\.file\.AccessDeniedException|java\.io\.FileNotFoundException): (?<path>\/data[^\r\n(]{0,160})(?: \(Permission denied\))?/;

const GENERIC_PERMISSION_RE =
  /Permission denied[^\r\n]{0,80}\/data|\/data[^\r\n]{0,80}Permission denied/;

/** The chown succeeding. The opposite of a problem, and a tempting false positive. */
const CHOWN_OK_RE = /Changing ownership of \/data to/;

export const dataNotWritable: Rule = {
  id: 'permissions.data-not-writable',
  title: 'The server cannot write to its own data folder',
  severity: 'critical',
  category: 'permissions',
  hints: ['permission denied', 'accessdeniedexception', 'writable by uid'],

  match(ctx: MatchContext): Match | null {
    for (const block of candidateBlocks(ctx.blocks)) {
      const itzg = ITZG_PERMISSION_RE.exec(block.text);
      if (itzg?.groups?.uid !== undefined) {
        return match([block], 'high', { uid: Number(itzg.groups.uid), signal: 'entrypoint' });
      }
      const java = JAVA_PERMISSION_RE.exec(block.text);
      if (java?.groups?.path !== undefined) {
        return match([block], 'high', { path: java.groups.path.trim(), signal: 'java' });
      }
      // The bare form is weak enough that the "ownership changed" success line must be absent —
      // otherwise a startup that fixed itself would be reported as broken.
      if (GENERIC_PERMISSION_RE.test(block.text) && !CHOWN_OK_RE.test(block.text)) {
        return match([block], 'medium', { signal: 'generic' });
      }
    }
    return null;
  },

  explain(m: Match): string {
    const path = detailString(m, 'path');
    const where = path === '' ? 'its data folder' : `"${path}"`;
    return (
      `The server was not allowed to write to ${where}. Its files are stored on the host machine, ` +
      `and the account the server runs as does not own them. This usually happens after files ` +
      `were copied in from elsewhere, or restored from a backup taken on another machine. The ` +
      `world itself is fine — the server simply cannot open it.`
    );
  },

  fixes(): Fix[] {
    return [
      {
        id: 'repair-permissions',
        title: 'Repair file ownership',
        detail:
          'Hands ownership of the server’s files back to the account it runs as. Only touches ' +
          'this server’s folder, and does not change any file contents.',
        kind: 'automatic',
        action: { type: 'repair_permissions' },
        confidence: 'high',
      },
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* Disk full                                                                   */
/* -------------------------------------------------------------------------- */

const NO_SPACE_RE = /No space left on device|ENOSPC|There is not enough space on the disk/;

export const diskFull: Rule = {
  id: 'disk.no-space',
  title: 'The disk is full',
  severity: 'critical',
  category: 'disk',
  hints: ['no space left on device', 'enospc', 'not enough space on the disk'],

  match(ctx: MatchContext): Match | null {
    for (const block of candidateBlocks(ctx.blocks)) {
      if (NO_SPACE_RE.test(block.text)) {
        return match([block], 'high', {});
      }
    }
    return null;
  },

  explain(): string {
    return (
      'The machine ran out of disk space, so the server could not write. This is dangerous for a ' +
      'Minecraft server specifically: a save that fails part-way through leaves the world in an ' +
      'inconsistent state. Free space before restarting, and check the world loaded properly ' +
      'afterwards.'
    );
  },

  fixes(): Fix[] {
    return [
      {
        id: 'free-disk-space',
        title: 'Free up disk space',
        detail:
          'Removes old backups and cached downloads beyond what your retention settings keep. ' +
          'Platter never deletes a world or the most recent backup.',
        kind: 'automatic',
        action: { type: 'free_disk_space' },
        confidence: 'high',
      },
      {
        id: 'check-host-disk',
        title: 'Check what is using the disk',
        detail:
          'If other things on this machine filled the disk, clearing Platter’s own files only ' +
          'buys time. Worth confirming before restarting.',
        kind: 'manual',
        confidence: 'medium',
      },
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* Download failures                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The server jar, the mod loader and every mod are downloaded at startup, before Minecraft
 * exists. A failure here produces no Minecraft log at all — just an entrypoint error and an
 * exit code — which is why it needs its own rule rather than falling out of a Java stack trace.
 */
const DOWNLOAD_FAIL_RE =
  /Failed to download|failed to download from|'(?<command>install-[a-z]+|[a-z-]+)' command failed|me\.itzg\.helpers\.errors\.(?:GenericException|InvalidParameterException)|reactor\.netty\.http\.client|PrematureCloseException/;

/** A 404 means the version does not exist upstream; retrying will never help. */
const NOT_FOUND_RE = /404 Not Found|status[= ]404|HTTP 404/;

export const downloadFailed: Rule = {
  id: 'startup.download-failed',
  title: 'The server could not download the files it needs',
  severity: 'critical',
  category: 'startup',
  hints: [
    'failed to download',
    'command failed',
    'reactor.netty.http.client',
    'prematurecloseexception',
    'me.itzg.helpers.errors',
  ],

  match(ctx: MatchContext): Match | null {
    for (const block of candidateBlocks(ctx.blocks)) {
      const found = DOWNLOAD_FAIL_RE.exec(block.text);
      if (found === null) {
        continue;
      }
      const notFound = NOT_FOUND_RE.test(block.text);
      return match([block], 'high', {
        notFound,
        ...(found.groups?.command === undefined ? {} : { command: found.groups.command }),
      });
    }
    return null;
  },

  explain(m: Match): string {
    if (m.details.notFound === true) {
      return (
        'The server tried to download a file that does not exist. That points at a version that ' +
        'was never published, or has been withdrawn — a specific mod build, or a loader version ' +
        'for a Minecraft version it does not support. Retrying will not help; the version needs ' +
        'changing.'
      );
    }
    return (
      'The server could not fetch the files it needs to start. Everything is downloaded fresh at ' +
      'startup, so a network problem or an outage at the mod site stops the server before ' +
      'Minecraft itself ever runs. These are usually temporary and clear on their own.'
    );
  },

  fixes(m: Match): Fix[] {
    if (m.details.notFound === true) {
      return [
        {
          id: 'pin-valid-version',
          title: 'Choose a version that exists',
          detail:
            'Check the exact version numbers for the loader and any pinned mods. Platter can show ' +
            'you what is actually published for your Minecraft version.',
          kind: 'manual',
          confidence: 'high',
        },
      ];
    }
    return [
      {
        id: 'retry-start',
        title: 'Try starting again',
        detail:
          'Download failures are usually a brief outage at the other end. Nothing is changed by ' +
          'retrying, and it succeeds more often than not.',
        kind: 'automatic',
        action: { type: 'retry_start' },
        confidence: 'medium',
      },
      {
        id: 'check-connectivity',
        title: 'Check the machine can reach the internet',
        detail:
          'If retrying keeps failing, the host may be behind a proxy or firewall that blocks the ' +
          'mod and loader download sites.',
        kind: 'manual',
        confidence: 'medium',
      },
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* Healthy but paused                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The one rule here that is not about a failure.
 *
 * When automatic pausing is on, the image's health check returns success without checking
 * anything — it sees the frozen Java process and reports healthy by design. So a paused server
 * shows green everywhere while nobody can join. Reporting "no problems found" in that state
 * would be technically true and completely useless, which is exactly the kind of answer that
 * destroys trust in a diagnosis tool.
 */
const PAUSED_LOG_RE =
  /Pausing (?:the )?(?:Java )?process|All clients disconnected - pausing|No client (?:re)?connected(?: since startup \/ knocked)? - pausing/;
const RESUMED_LOG_RE = /Resuming|Client connected - waiting for disconnect|Client reconnected/;

export const serverPaused: Rule = {
  id: 'startup.server-paused',
  title: 'The server is paused and cannot be joined',
  severity: 'info',
  category: 'startup',

  match(ctx: MatchContext): Match | null {
    if (ctx.paused === true) {
      return match([], 'high', { signal: 'state-file', health: ctx.health ?? 'none' });
    }
    if (ctx.server.autopauseEnabled !== true) {
      return null;
    }
    // Fall back to reading the pause daemon's own commentary, newest first: a later resume
    // cancels an earlier pause.
    for (let i = ctx.blocks.length - 1; i >= 0; i--) {
      const block = ctx.blocks[i];
      if (block === undefined) {
        continue;
      }
      if (RESUMED_LOG_RE.test(block.text)) {
        return null;
      }
      if (PAUSED_LOG_RE.test(block.text)) {
        return match([block], 'medium', { signal: 'log', health: ctx.health ?? 'none' });
      }
    }
    return null;
  },

  explain(m: Match): string {
    const healthy = detailString(m, 'health') === 'healthy';
    const note = healthy
      ? ' This is why the server still shows as healthy: the health check deliberately reports ' +
        'success while paused, so it is not a sign that anything is wrong.'
      : '';
    return (
      `The server is asleep. It does this on its own after everyone leaves, to stop using the ` +
      `machine's processor while nobody is playing, and wakes up when someone connects.${note} ` +
      `If players report that they cannot join, ask them to try once more — the first attempt ` +
      `wakes it and may time out.`
    );
  },

  fixes(): Fix[] {
    return [
      {
        id: 'no-action-needed',
        title: 'No action needed',
        detail:
          'Pausing is working as intended. Turn it off only if the wake-up delay is a problem for ' +
          'your players.',
        kind: 'manual',
        confidence: 'high',
      },
    ];
  },
};

/**
 * Not a rule — a helper the memory rules would otherwise duplicate. Exported so the summary
 * builder can describe a memory-shaped problem without re-deriving the number.
 */
export function describeMemoryTarget(ctx: MatchContext): string {
  return formatMiB(recommendMemory(ctx).memoryMiB);
}
