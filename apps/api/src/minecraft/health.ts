import { isUnknownCommand, stripFormatting } from './players.js';

/**
 * Tick health, where the server offers it.
 *
 * Paper, Purpur and the forks downstream of them implement `/tps` and `/mspt`. Vanilla and
 * Fabric implement neither, and there is no way to derive either number from outside the
 * process — the container's CPU usage says nothing about whether the game loop is keeping
 * up, because a server pegged at 100% CPU can be at a perfect 20 TPS and one at 5% CPU can
 * be stalling on disk.
 *
 * So a server that does not report tick health reports *nothing*. A plausible-looking
 * number invented from container stats would be worse than an empty panel: it is the one
 * metric an operator acts on, and acting on a fiction wastes their afternoon.
 */

export interface TpsReading {
  oneMinute: number;
  fiveMinutes: number;
  fifteenMinutes: number;
  /**
   * Spigot marks a figure it had to estimate with an asterisk (`*20.0`), which means the
   * server has not been up long enough to fill that window.
   */
  estimated: boolean;
}

export interface MsptWindow {
  average: number;
  peak: number;
}

export interface MsptReading {
  fiveSeconds: MsptWindow;
  oneMinute: MsptWindow;
  fiveMinutes: MsptWindow;
}

/**
 * Why there is no reading. `unsupported` is by far the most common and is not a fault.
 *
 * `unconfigured` is deliberately separate from `offline`: a running server whose RCON is
 * switched off has a fix the operator can act on, and telling them to start a server that
 * is already started is the kind of contradiction that makes people stop trusting a panel.
 */
export type HealthUnavailableReason = 'unsupported' | 'unconfigured' | 'unreadable' | 'offline';

export interface MinecraftHealth {
  tps: TpsReading | null;
  mspt: MsptReading | null;
  /** Null when at least one reading came back. */
  unavailable: HealthUnavailableReason | null;
}

/**
 * A tick is 50ms, so 20 TPS is the ceiling. Paper briefly reports a hair above it while
 * catching up, hence the small headroom; anything beyond that is a parse that latched onto
 * the wrong number.
 */
const MAX_PLAUSIBLE_TPS = 25;
/** A tick taking longer than a minute means the server is not running, not that it is slow. */
const MAX_PLAUSIBLE_MSPT = 60_000;

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number.parseFloat(raw.replace('*', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses `/tps`.
 *
 * Paper prints `TPS from last 1m, 5m, 15m: 20.0, 20.0, 19.98`; Spigot prints the same
 * header with asterisks on estimated figures; Purpur adds memory lines after it. Colour
 * codes sit between the header and each number, so formatting is stripped first and the
 * three figures are taken from the tail of the header line rather than from the whole
 * output — Purpur's memory line also contains decimals.
 */
export function parseTps(output: string): TpsReading | null {
  const text = stripFormatting(output);
  const line = text.split(/\r?\n/).find((candidate) => /tps from last/i.test(candidate));
  if (line === undefined) return null;

  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const figures = line.slice(colon + 1).match(/\*?\d+(?:\.\d+)?/g);
  if (!figures || figures.length < 3) return null;

  const values = figures.slice(0, 3).map(toNumber);
  const [oneMinute, fiveMinutes, fifteenMinutes] = values;
  if (
    oneMinute === null ||
    oneMinute === undefined ||
    fiveMinutes === null ||
    fiveMinutes === undefined ||
    fifteenMinutes === null ||
    fifteenMinutes === undefined
  ) {
    return null;
  }
  if (
    [oneMinute, fiveMinutes, fifteenMinutes].some((value) => value < 0 || value > MAX_PLAUSIBLE_TPS)
  ) {
    return null;
  }

  return {
    oneMinute,
    fiveMinutes,
    fifteenMinutes,
    estimated: figures.slice(0, 3).some((figure) => figure.startsWith('*')),
  };
}

/**
 * Parses `/mspt`.
 *
 * Paper prints a header line and then three `average/peak` pairs for the last 5 seconds,
 * minute and five minutes, wrapped in box-drawing characters. The pairs are matched
 * directly, which makes the decoration irrelevant.
 */
export function parseMspt(output: string): MsptReading | null {
  const text = stripFormatting(output);
  if (!/tick times|mspt/i.test(text)) return null;

  const pairs = [...text.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)];
  if (pairs.length < 3) return null;

  const windows: MsptWindow[] = [];
  for (const pair of pairs.slice(0, 3)) {
    const average = toNumber(pair[1]);
    const peak = toNumber(pair[2]);
    if (average === null || peak === null) return null;
    if (average < 0 || peak < 0 || average > MAX_PLAUSIBLE_MSPT || peak > MAX_PLAUSIBLE_MSPT) {
      return null;
    }
    windows.push({ average, peak });
  }

  const [fiveSeconds, oneMinute, fiveMinutes] = windows;
  if (!fiveSeconds || !oneMinute || !fiveMinutes) return null;
  return { fiveSeconds, oneMinute, fiveMinutes };
}

/** Runs one console command and returns its output. Supplied by the caller so this module
 * stays free of transport and database concerns. */
export type ConsoleRunner = (command: string) => Promise<string>;

/**
 * Asks a server for its tick health.
 *
 * Both commands are attempted because a server can implement one without the other — older
 * Paper has `/tps` and no `/mspt` — and because `/mspt` is the more useful of the two:
 * average tick time degrades smoothly where TPS sits pinned at 20.0 until it suddenly does
 * not. Neither answering is reported as `unsupported`, not as an error.
 */
export async function readMinecraftHealth(run: ConsoleRunner): Promise<MinecraftHealth> {
  const [tpsOutput, msptOutput] = await Promise.all([
    run('tps').catch(() => null),
    run('mspt').catch(() => null),
  ]);

  // A server that could not be reached at all is a different answer from one that answered
  // "unknown command", and the caller needs to be able to tell them apart.
  if (tpsOutput === null && msptOutput === null) {
    return { tps: null, mspt: null, unavailable: 'offline' };
  }

  const tps = tpsOutput === null ? null : parseTps(tpsOutput);
  const mspt = msptOutput === null ? null : parseMspt(msptOutput);
  if (tps !== null || mspt !== null) return { tps, mspt, unavailable: null };

  const unknown =
    (tpsOutput === null || isUnknownCommand(tpsOutput)) &&
    (msptOutput === null || isUnknownCommand(msptOutput));
  return { tps: null, mspt: null, unavailable: unknown ? 'unsupported' : 'unreadable' };
}
