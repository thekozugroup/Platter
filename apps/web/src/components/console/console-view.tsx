import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LogLine } from '@platter/shared';
import { formatCount } from '@platter/shared';
import { ArrowDown } from 'pixelarticons/react/ArrowDown.js';
import { Close } from 'pixelarticons/react/Close.js';
import { Copy } from 'pixelarticons/react/Copy.js';
import { Download } from 'pixelarticons/react/Download.js';
import { Search } from 'pixelarticons/react/Search.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ConnectionState } from '@/lib/console-socket.js';
import { saveBlob } from '@/hooks/use-files.js';
import { cn } from '@/lib/utils';

/**
 * The console output pane.
 *
 * Three problems decide this component's shape, and each of them is the reason a naive
 * implementation falls over on a real server:
 *
 * 1. **Volume.** A modded Minecraft server logs thousands of lines a minute. Rendering the
 *    whole buffer re-lays-out the tab on every frame, so only the rows inside the viewport
 *    are ever in the DOM. Because the text is monospace, one measurement of a single glyph
 *    is enough to compute every wrapped row height exactly — no per-row measurement, no
 *    resize-observer per line, and no guessing.
 * 2. **Reading while it moves.** Autoscroll follows the tail only while the reader is
 *    already at the tail. Scroll up and the view stays put; a pill appears with the count of
 *    what arrived while you were reading.
 * 3. **Escape codes.** Servers emit ANSI colour, cursor moves and progress-bar carriage
 *    returns. Printed raw they are garbage, so they are removed here rather than shown.
 *    Minecraft's own legacy `§` codes go the same way.
 *
 * The pane never calls `focus()`. A console that grabs focus as lines land makes the command
 * input unusable and steals the caret out from under a screen reader.
 */

// --------------------------------------------------------------------------------------
// Text normalisation
// --------------------------------------------------------------------------------------

/** CSI sequences, OSC strings (both BEL- and ST-terminated), and single-character escapes. */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

/** Minecraft’s legacy formatting codes — colour and style, meaningless as text. */
const SECTION_CODE_PATTERN = /§[0-9a-fk-orA-FK-OR]/g;

/** Everything else non-printable. Tabs are handled separately; newlines never reach here. */
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const TAB_WIDTH = 4;

/**
 * One log line as it should actually be read.
 *
 * A carriage return means "overwrite this line from the start" — that is how progress bars
 * are drawn — so only the final segment is real output. Exported for the tests, which is
 * also the only place the individual rules are worth asserting.
 */
export function normaliseLogText(raw: string): string {
  const overwritten = raw.split('\r');
  let text = raw;
  if (overwritten.length > 1) {
    // Take the last segment that actually wrote something; a trailing CR writes nothing.
    for (let index = overwritten.length - 1; index >= 0; index -= 1) {
      const candidate = overwritten[index] ?? '';
      if (candidate.length > 0) {
        text = candidate;
        break;
      }
      if (index === 0) text = '';
    }
  }

  return text
    .replace(ANSI_PATTERN, '')
    .replace(SECTION_CODE_PATTERN, '')
    .replace(/\t/g, ' '.repeat(TAB_WIDTH))
    .replace(CONTROL_PATTERN, '');
}

/** `2026-08-07T18:04:11.223Z` -> `18:04:11`. Falls back to blank rather than to `Invalid Date`. */
function clockTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return '--:--:--';
  return parsed.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// --------------------------------------------------------------------------------------
// Geometry
// --------------------------------------------------------------------------------------

/**
 * Row height in pixels, and the same value as a token for the CSS side. These two must agree:
 * the virtualiser positions rows arithmetically, so a row that renders taller than the
 * scroller thinks it is drifts the whole list.
 */
const ROW_HEIGHT = 24; // keep in step with ROW_LEADING below (--pl-space-lg)
const ROW_LEADING = 'leading-[var(--pl-space-lg)]';

/** How many characters wide the measurement probe is. Wider is more accurate; 80 is plenty. */
const PROBE_WIDTH = 80;

/** Rows rendered above and below the viewport, so a fast flick never shows a blank band. */
const OVERSCAN_ROWS = 8;

/**
 * What to render before the scroller has been measured — in a test environment, and on the
 * very first paint, `clientHeight` is 0 and a purely computed window would render nothing.
 */
const UNMEASURED_ROWS = 60;

/** Treat "within one row of the bottom" as being at the bottom; exact equality never holds. */
const STICK_THRESHOLD = ROW_HEIGHT;

const STREAM_CLASS: Record<LogLine['stream'], string> = {
  stdout: 'text-console-fg',
  stderr: 'text-console-stderr',
  system: 'text-console-system',
};

const STREAM_LABEL: Record<LogLine['stream'], string> = {
  stdout: 'Output',
  stderr: 'Error output',
  system: 'Platter',
};

interface PreparedLine {
  key: number;
  stream: LogLine['stream'];
  text: string;
  time: string;
}

// --------------------------------------------------------------------------------------

export interface ConsoleViewProps {
  lines: readonly LogLine[];
  connectionState: ConnectionState;
  /** Used in the download filename and the accessible name. */
  serverName: string;
  /** Clears the on-screen buffer. Omit to hide the control. */
  onClear?: (() => void) | undefined;
  className?: string;
}

export function ConsoleView({
  lines,
  connectionState,
  serverName,
  onClear,
  className,
}: ConsoleViewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentProbeRef = useRef<HTMLSpanElement | null>(null);
  const charProbeRef = useRef<HTMLSpanElement | null>(null);

  const searchId = useId();
  const statusId = useId();

  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(true);
  const [showTimes, setShowTimes] = useState(true);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const [charsPerRow, setCharsPerRow] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  /** Following the tail. Starts true so a fresh console opens at the newest line. */
  const [following, setFollowing] = useState(true);
  const [missed, setMissed] = useState(0);

  // -- the buffer, normalised and filtered ----------------------------------------------

  const prepared = useMemo<PreparedLine[]>(
    () =>
      lines.map((line, index) => ({
        key: index,
        stream: line.stream,
        text: normaliseLogText(line.content),
        time: clockTime(line.timestamp),
      })),
    [lines],
  );

  const trimmedQuery = query.trim();
  const visible = useMemo(() => {
    if (trimmedQuery === '') return prepared;
    const needle = trimmedQuery.toLowerCase();
    return prepared.filter((line) => line.text.toLowerCase().includes(needle));
  }, [prepared, trimmedQuery]);

  const filtering = trimmedQuery !== '';

  // -- measurement -----------------------------------------------------------------------

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const contentProbe = contentProbeRef.current;
    if (!scroller || !contentProbe) return;

    function measure() {
      const charProbe = charProbeRef.current;
      const probe = contentProbeRef.current;
      const element = scrollerRef.current;
      if (!charProbe || !probe || !element) return;

      const glyph = charProbe.getBoundingClientRect().width / PROBE_WIDTH;
      const available = probe.getBoundingClientRect().width;
      setCharsPerRow(
        glyph > 0 && available > 0 ? Math.max(1, Math.floor(available / glyph)) : 0,
      );
      setViewport((previous) =>
        previous.height === element.clientHeight && previous.top === element.scrollTop
          ? previous
          : { top: element.scrollTop, height: element.clientHeight },
      );
    }

    measure();

    // Fonts load after first paint; a stale glyph width would mis-wrap every row until the
    // next resize, so re-measure once the console's monospace face is actually in use.
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(measure).catch(() => undefined);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(contentProbe);
    return () => observer.disconnect();
  }, []);

  // -- row layout ------------------------------------------------------------------------

  /**
   * Cumulative row offsets. Monospace means a line's height is exactly
   * `ceil(length / charsPerRow)` rows — no DOM measurement per line, which is what keeps
   * this O(n) over a cheap loop instead of O(n) layouts.
   */
  const { offsets, totalRows } = useMemo(() => {
    const result = new Array<number>(visible.length + 1);
    let running = 0;
    for (let index = 0; index < visible.length; index += 1) {
      result[index] = running;
      const length = visible[index]?.text.length ?? 0;
      running += wrap && charsPerRow > 0 ? Math.max(1, Math.ceil(length / charsPerRow)) : 1;
    }
    result[visible.length] = running;
    return { offsets: result, totalRows: running };
  }, [visible, wrap, charsPerRow]);

  /** First index whose row range contains `row`. */
  const indexAtRow = useCallback(
    (row: number): number => {
      let low = 0;
      let high = visible.length - 1;
      let answer = 0;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if ((offsets[middle] ?? 0) <= row) {
          answer = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return answer;
    },
    [offsets, visible.length],
  );

  const measured = viewport.height > 0;
  const visibleRows = measured
    ? Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN_ROWS * 2
    : UNMEASURED_ROWS;

  const firstRow = measured ? Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN_ROWS) : 0;
  const startIndex = visible.length === 0 ? 0 : indexAtRow(firstRow);
  const endIndex = Math.min(visible.length, indexAtRow(firstRow + visibleRows) + 1);

  const padTop = (offsets[startIndex] ?? 0) * ROW_HEIGHT;
  const padBottom = Math.max(0, (totalRows - (offsets[endIndex] ?? totalRows)) * ROW_HEIGHT);

  // -- autoscroll ------------------------------------------------------------------------

  const previousCount = useRef(visible.length);

  const handleScroll = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    setViewport({ top: element.scrollTop, height: element.clientHeight });

    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distance <= STICK_THRESHOLD;
    setFollowing(atBottom);
    if (atBottom) setMissed(0);
  }, []);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    const grew = visible.length - previousCount.current;
    previousCount.current = visible.length;

    if (following) {
      // `scrollTop` only — never `scrollIntoView`, which scrolls ancestors and can move the
      // whole page out from under someone reading a different part of it.
      if (element) element.scrollTop = element.scrollHeight;
      if (missed !== 0) setMissed(0);
      return;
    }
    if (grew > 0) setMissed((count) => count + grew);
    // `missed` is deliberately not a dependency: it is written here, and reading it would
    // re-run this effect on its own update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, totalRows, following]);

  const jumpToLatest = useCallback(() => {
    const element = scrollerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setFollowing(true);
    setMissed(0);
  }, []);

  // -- export ----------------------------------------------------------------------------

  const plainText = useCallback(
    () =>
      visible
        .map((line) => (showTimes ? `${line.time} ${line.text}` : line.text))
        .join('\n'),
    [visible, showTimes],
  );

  const copyAll = useCallback(async () => {
    const text = plainText();
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      // Permission refused, or a non-secure context — the panel is often served over plain
      // HTTP on a LAN, where the async clipboard API simply is not available.
    }
    if (!ok) {
      const staging = document.createElement('textarea');
      try {
        staging.value = text;
        staging.setAttribute('readonly', '');
        staging.style.position = 'fixed';
        staging.style.opacity = '0';
        document.body.appendChild(staging);
        staging.select();
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      } finally {
        staging.remove();
      }
    }
    setCopyState(ok ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), ok ? 2000 : 6000);
  }, [plainText]);

  const download = useCallback(() => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    saveBlob(
      new Blob([`${plainText()}\n`], { type: 'text/plain;charset=utf-8' }),
      `${serverName.replace(/[^\w.-]+/g, '-').toLowerCase() || 'server'}-console-${stamp}.log`,
    );
  }, [plainText, serverName]);

  const empty = visible.length === 0;
  const live = connectionState === 'open';

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-md border border-separator-strong',
        'bg-console-bg',
        className,
      )}
    >
      {/* ---- toolbar ---- */}
      <div className="flex flex-wrap items-center gap-2 border-b border-console-dim/25 px-3 py-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <label className="sr-only" htmlFor={searchId}>
            Filter console lines
          </label>
          <Search
            aria-hidden
            className="pointer-events-none absolute inset-s-2.5 top-1/2 size-4 -translate-y-1/2 text-console-dim"
          />
          <Input
            className={cn(
              'h-11 w-full ps-9 pe-9 font-mono text-footnote',
              'border-console-dim/30 bg-transparent text-console-fg',
              'placeholder:text-console-dim',
            )}
            id={searchId}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter lines"
            type="search"
            value={query}
          />
          {filtering ? (
            <Button
              aria-label="Clear the filter"
              className="hit-target absolute inset-e-1 top-1/2 size-8 -translate-y-1/2 text-console-dim hover:bg-console-fg/10 hover:text-console-fg"
              onClick={() => setQuery('')}
              size="icon-md"
              variant="ghost"
            >
              <Close aria-hidden />
            </Button>
          ) : null}
        </div>

        {/*
          Ark's Switch already renders its own label element, so it carries the name itself
          rather than being wrapped in a second one. The visible word is contained in the
          accessible name, which is what WCAG's "label in name" asks for.
        */}
        <div className="flex h-11 items-center gap-2 px-1 text-caption text-console-dim">
          <Switch
            aria-label="Wrap long lines"
            checked={wrap}
            className="hit-target"
            onCheckedChange={({ checked }) => setWrap(checked === true)}
          />
          <span aria-hidden>Wrap</span>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={showTimes ? 'Hide timestamps' : 'Show timestamps'}
              aria-pressed={showTimes}
              className={cn(
                'h-11 rounded-button px-3 text-caption font-medium',
                'text-console-dim hover:bg-console-fg/10 hover:text-console-fg',
                showTimes && 'text-console-fg',
              )}
              onClick={() => setShowTimes((value) => !value)}
              variant="ghost"
            >
              Time
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {showTimes ? 'Hide the timestamp gutter' : 'Show the timestamp gutter'}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={
                filtering ? 'Copy the filtered lines' : 'Copy the whole console buffer'
              }
              className="hit-target size-11 text-console-dim hover:bg-console-fg/10 hover:text-console-fg"
              onClick={() => void copyAll()}
              size="icon-lg"
              variant="ghost"
            >
              <Copy aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {filtering ? `Copy ${formatCount(visible.length, 'matching line')}` : 'Copy all lines'}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Download the console log"
              className="hit-target size-11 text-console-dim hover:bg-console-fg/10 hover:text-console-fg"
              onClick={download}
              size="icon-lg"
              variant="ghost"
            >
              <Download aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download as a .log file</TooltipContent>
        </Tooltip>

        {onClear ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Clear the console view"
                className="hit-target size-11 text-console-dim hover:bg-console-fg/10 hover:text-console-fg"
                onClick={onClear}
                size="icon-lg"
                variant="ghost"
              >
                <Close aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Clear what is on screen. The server keeps writing to its own log.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {/* ---- output ---- */}
      <div className="relative min-h-0 flex-1">
        <div
          aria-atomic="false"
          aria-describedby={statusId}
          aria-label={`Console output for ${serverName}`}
          /*
           * `role="log"` announces new lines as they arrive — but only while the view is
           * actually following the tail. Once someone scrolls up to read, rows entering and
           * leaving the virtual window are scrolling artefacts, not new output, and
           * announcing them would talk over what they are trying to read.
           */
          aria-live={following && live ? 'polite' : 'off'}
          className={cn(
            'h-full overflow-auto overscroll-contain px-3 py-2',
            'font-mono text-footnote selection:bg-console-fg/25',
          )}
          onScroll={handleScroll}
          ref={scrollerRef}
          role="log"
          tabIndex={0}
        >
          {/*
            A zero-height clone of a real row. The outer span reports the exact width text
            gets after the gutter, and the inner one measures a single glyph — together they
            give the character-per-row figure the virtualiser wraps with.
          */}
          <div aria-hidden className="flex h-0 gap-3 overflow-hidden">
            {showTimes ? <span className="w-[8ch] shrink-0">00:00:00</span> : null}
            <span className="min-w-0 flex-1" ref={contentProbeRef}>
              <span className="absolute whitespace-pre" ref={charProbeRef}>
                {'0'.repeat(PROBE_WIDTH)}
              </span>
            </span>
          </div>

          {empty ? (
            <p className="py-6 text-console-dim">
              {filtering
                ? `No line matches “${trimmedQuery}”.`
                : connectionState === 'closed'
                  ? 'The console is not connected.'
                  : 'Waiting for output. Nothing has been logged yet.'}
            </p>
          ) : (
            <div className={cn('min-w-full', !wrap && 'w-max')}>
              <div style={{ height: padTop }} />
              {visible.slice(startIndex, endIndex).map((line) => (
                <div
                  className={cn('flex gap-3', ROW_LEADING)}
                  data-stream={line.stream}
                  key={line.key}
                >
                  {showTimes ? (
                    <span className="w-[8ch] shrink-0 tabular text-console-dim">{line.time}</span>
                  ) : null}
                  <span
                    className={cn(
                      'min-w-0 flex-1',
                      wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
                      STREAM_CLASS[line.stream],
                    )}
                  >
                    {line.stream !== 'stdout' ? (
                      <span className="sr-only">{`${STREAM_LABEL[line.stream]}: `}</span>
                    ) : null}
                    {filtering ? <Highlighted needle={trimmedQuery} text={line.text} /> : line.text}
                  </span>
                </div>
              ))}
              <div style={{ height: padBottom }} />
            </div>
          )}
        </div>

        {/* ---- jump to latest ---- */}
        {!following ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              className={cn(
                'pointer-events-auto h-11 rounded-pill px-4 text-caption font-medium',
                'border border-console-dim/40 bg-console-bg text-console-fg shadow-2',
                'hover:bg-console-fg/10',
              )}
              onClick={jumpToLatest}
              variant="ghost"
            >
              <ArrowDown aria-hidden />
              {missed > 0 ? `${formatCount(missed, 'new line')}` : 'Jump to latest'}
            </Button>
          </div>
        ) : null}
      </div>

      {/*
        ---- status line ----

        Deliberately NOT a live region as a whole. Its first child is the line count, which
        changes on every arriving line, so `role="status"` here re-announced "24 lines ·
        Following the latest output", "25 lines · …" on top of the `role="log"` region
        already announcing the lines themselves — on a busy server a screen reader never
        stopped talking. The live region is now scoped to the two things that change on a
        *user action*: whether the view is following, and whether a copy landed.
      */}
      <p
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-console-dim/25 px-3 py-2 text-caption-2 text-console-dim"
        id={statusId}
      >
        <span className="tabular">
          {filtering
            ? `${visible.length.toLocaleString()} of ${prepared.length.toLocaleString()} lines match`
            : formatCount(prepared.length, 'line')}
        </span>
        <span aria-hidden>·</span>
        <span aria-live="polite" className="contents" role="status">
          <span>{following ? 'Following the latest output' : 'Paused while you scroll'}</span>
          {copyState === 'copied' ? (
            <span className="text-console-fg">Copied to clipboard</span>
          ) : null}
          {copyState === 'failed' ? (
            <span className="text-console-stderr">
              Couldn’t reach the clipboard. Select the text and press Ctrl+C.
            </span>
          ) : null}
        </span>
      </p>
    </div>
  );
}

/**
 * The matched substrings, marked with the console's own highlight token. Splitting the text
 * changes the markup but not a single character of it, so the wrap arithmetic above still
 * holds exactly.
 */
function Highlighted({ text, needle }: { text: string; needle: string }) {
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: ReactNode[] = [];

  let cursor = 0;
  let found = haystack.indexOf(target, cursor);
  let piece = 0;
  while (found !== -1 && target.length > 0) {
    if (found > cursor) parts.push(text.slice(cursor, found));
    parts.push(
      <mark
        className="bg-[var(--pl-console-highlight)] text-console-fg"
        key={`${piece}-${found}`}
      >
        {text.slice(found, found + target.length)}
      </mark>,
    );
    cursor = found + target.length;
    piece += 1;
    found = haystack.indexOf(target, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));

  return <>{parts}</>;
}
