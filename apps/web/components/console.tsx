'use client';

import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import type { ServerStatus } from '@platter/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sendCommandAction, startServerAction } from '@/lib/actions';

interface LogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  timestamp: number | undefined;
  text: string;
}

/**
 * A line as rendered.
 *
 * `key` is assigned by the client, not taken from `seq`. Docker's sequence number restarts at
 * zero on every reconnect and locally-injected RCON responses have no sequence at all, so `seq`
 * is unique only within one connection — using it as a React key collides the moment the stream
 * reconnects, and React then reuses the wrong DOM node for the wrong line.
 */
interface ConsoleLine extends LogLine {
  key: string;
  /** `local` means Platter wrote it — an RCON response, not container output. */
  origin: 'container' | 'local';
}

/**
 * Where the console got to, so a reconnect can resume instead of replaying.
 *
 * Docker's `since` filter is second-granular, so asking to resume at a millisecond still returns
 * every line from that whole second. `texts` holds the lines already shown *at exactly*
 * `timestamp`, which is what lets the boundary second be de-duplicated precisely rather than by
 * dropping it wholesale — dropping it loses real output, keeping it duplicates real output.
 */
interface ResumePoint {
  timestamp: number;
  texts: string[];
}

/**
 * How many lines the console holds.
 *
 * A crash-looping modded server produces thousands of lines a minute. Keeping them all turns the
 * tab into a memory leak and the DOM into a slideshow, and nobody scrolls back past a few
 * hundred anyway — that is what the diagnosis engine is for.
 */
const MAX_LINES = 2000;

/**
 * The live console.
 *
 * Two channels, deliberately: log output streams in over SSE, and commands go out over RCON
 * (falling back to stdin). Every other panel scrapes command output from the log tail, which
 * breaks the moment a mod reconfigures logging and cannot tell you *which* output belonged to
 * *your* command. A request/response channel just answers the question.
 */
export function Console({ serverId, status }: { serverId: string; status: ServerStatus }) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [follow, setFollow] = useState(true);
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  /** Why the stream is not connected, when the endpoint told us. */
  const [failure, setFailure] = useState<{ status: number; message: string } | null>(null);
  const [starting, setStarting] = useState(false);

  const scroller = useRef<HTMLDivElement | null>(null);
  const showToast = useToast();

  // Monotonic across reconnects and across locally-injected lines, which is exactly what `seq`
  // is not.
  const nextKey = useRef(0);
  const makeKey = useCallback(() => {
    nextKey.current += 1;
    return `l${nextKey.current}`;
  }, []);

  const resume = useRef<ResumePoint | null>(null);

  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) {
        return;
      }

      const from = resume.current;
      const query = new URLSearchParams({ tail: from ? '2000' : '400' });
      if (from) {
        query.set('since', String(from.timestamp));
      }
      source = new EventSource(`/api/servers/${serverId}/logs?${query.toString()}`);

      /*
       * Lines already shown at the resume boundary, consumed one occurrence at a time as the
       * replay repeats them. Local to this connection: once the stream moves past the boundary
       * second there is nothing left to filter, and the next reconnect builds a fresh one.
       */
      let pending: string[] | null = from ? [...from.texts] : null;
      const boundary = from?.timestamp;

      source.addEventListener('open', () => {
        attempt = 0;
        setConnected(true);
        setFailure(null);
      });

      source.addEventListener('line', (event) => {
        const line = JSON.parse((event as MessageEvent<string>).data) as LogLine;

        // De-duplicate the replayed tail against what the console already holds.
        if (pending !== null && boundary !== undefined && line.timestamp !== undefined) {
          if (line.timestamp < boundary) {
            return;
          }
          if (line.timestamp === boundary) {
            const at = pending.indexOf(line.text);
            if (at !== -1) {
              pending.splice(at, 1);
              return;
            }
          } else {
            // Docker emits in order, so the first newer line means the boundary is behind us.
            pending = null;
          }
        }

        if (line.timestamp !== undefined) {
          const point = resume.current;
          if (point === null || line.timestamp > point.timestamp) {
            resume.current = { timestamp: line.timestamp, texts: [line.text] };
          } else if (line.timestamp === point.timestamp) {
            point.texts.push(line.text);
          }
        }

        setLines((current) => {
          const next = current.length >= MAX_LINES ? current.slice(-MAX_LINES + 1) : current;
          return [...next, { ...line, key: makeKey(), origin: 'container' as const }];
        });
      });

      source.addEventListener('error', () => {
        setConnected(false);
        source?.close();
        if (closed) {
          return;
        }

        /*
         * Find out *why*, because the endpoint knows and `EventSource` throws that away.
         *
         * A server with no container answers 409 with "Server has no container" — actionable,
         * final, and previously discarded in favour of an indefinite 20-second retry loop under
         * a "Waiting for output…" message that would never stop waiting. A one-shot fetch of the
         * same URL costs nothing and turns a lie into an explanation.
         */
        void fetch(`/api/servers/${serverId}/logs?tail=1`)
          .then(async (response) => {
            if (closed || response.ok) {
              return;
            }
            const body = (await response.text()).trim();
            setFailure({
              status: response.status,
              message: body || 'The log stream is unavailable.',
            });
          })
          .catch(() => undefined);

        // A stopped server closes the stream immediately; backing off keeps this from becoming
        // a reconnect loop against a container that is not coming back.
        attempt = Math.min(attempt + 1, 6);
        retry = setTimeout(connect, Math.min(20_000, 1000 * 2 ** attempt));
      });
    };

    connect();

    return () => {
      closed = true;
      source?.close();
      if (retry) {
        clearTimeout(retry);
      }
    };
  }, [serverId, makeKey]);

  // Stick to the bottom only while the user is already there. Yanking them back down mid-read
  // makes the console unusable exactly when they are trying to read an error.
  // `lines` is the trigger, not an input: the effect reads the DOM rather than the array, and
  // has to re-run on every append.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    if (!follow || !scroller.current) {
      return;
    }
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines, follow]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    setFollow(atBottom);
  }, []);

  const submit = useCallback(async () => {
    const trimmed = command.trim();
    if (trimmed.length === 0 || sending) {
      return;
    }
    setSending(true);
    setCommand('');
    setHistory((current) => [trimmed, ...current.filter((item) => item !== trimmed)].slice(0, 50));
    setHistoryIndex(-1);

    const result = await sendCommandAction(serverId, trimmed);
    setSending(false);

    if (!result.ok) {
      showToast({ body: result.message ?? 'Command failed.', type: 'error' });
      return;
    }
    if (result.response && result.response.trim().length > 0) {
      // RCON responses never appear in the log, so they are injected locally and marked so the
      // reader can tell them apart from server output.
      setLines((current) => [
        ...current,
        {
          key: makeKey(),
          origin: 'local' as const,
          seq: -1,
          stream: 'stdout',
          // Rendered without a clock: this line never came from the container, so stamping it
          // alongside real output invites reading it as something the server logged.
          timestamp: undefined,
          text: `> ${trimmed}\n${result.response}`,
        },
      ]);
    }
  }, [command, makeKey, sending, serverId, showToast]);

  const running = status === 'running' || status === 'unhealthy' || status === 'starting';

  /*
   * What the toolbar says about the stream.
   *
   * Only claims "showing the last output" when output was actually received. The previous
   * version asserted it for every non-connected state, including the one where the request was
   * refused and nothing was ever fetched.
   */
  const streamStatus = connected
    ? `Streaming · ${lines.length} line${lines.length === 1 ? '' : 's'}`
    : lines.length > 0
      ? `Disconnected · showing ${lines.length} line${lines.length === 1 ? '' : 's'} received earlier`
      : failure
        ? 'Not streaming.'
        : running
          ? 'Connecting…'
          : 'Not running.';

  return (
    <VStack gap={3} minHeight={0}>
      <HStack justify="between" align="center" gap={3} wrap="wrap">
        {/*
         * The one thing worth announcing. The log itself is not a live region — see the
         * `aria-live="off"` note on the console below.
         */}
        <Text type="supporting" aria-live="polite">
          {streamStatus}
        </Text>
        <HStack gap={3} align="center">
          <Switch label="Follow output" value={follow} onChange={setFollow} size="sm" />
          <Button
            label="Clear"
            variant="ghost"
            size="sm"
            isDisabled={lines.length === 0}
            onClick={() => setLines([])}
          />
        </HStack>
      </HStack>

      {/*
       * `role="log"` with `aria-live="off"`, and focusable.
       *
       * The region was `aria-live="polite"` over the whole log, which queues every appended line
       * for announcement. A crash-looping modded server emits thousands of lines a minute, so a
       * screen reader would never stop talking — the user could not hear the toasts, the command
       * errors, or anything else on the page. Connection state is announced by the toolbar line
       * above instead, which changes a handful of times rather than continuously.
       *
       * `tabIndex={0}` because a scrollable region has to be reachable by keyboard (WCAG 2.1.1);
       * before the flex-end fix it was not scrollable at all, so this was moot.
       */}
      <section
        className="platter-console"
        ref={scroller}
        onScroll={onScroll}
        aria-label="Server console output"
        role="log"
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1 requires a scrollable region to be keyboard reachable.
        tabIndex={0}
      >
        {lines.length === 0 ? (
          <EmptyState
            isCompact
            title={failure ? 'No console output' : running ? 'Waiting for output…' : 'Not running'}
            description={
              failure
                ? failure.status === 409
                  ? 'This server has never been started, so there is no container to read logs from.'
                  : failure.message
                : running
                  ? 'Connected to the server. Output appears here as it is produced.'
                  : 'Start the server to see its console. Your world is safe on disk in the meantime.'
            }
            {...(running
              ? {}
              : {
                  actions: (
                    <Button
                      label="Start server"
                      variant="primary"
                      isLoading={starting}
                      onClick={() => {
                        setStarting(true);
                        void startServerAction(serverId)
                          .then((outcome) => {
                            if (!outcome.ok) {
                              showToast({
                                body: outcome.message ?? 'Could not start the server.',
                                type: 'error',
                              });
                            }
                          })
                          .finally(() => setStarting(false));
                      }}
                    />
                  ),
                })}
          />
        ) : (
          <span className="platter-console__body">
            {lines.map((line) => (
              <span
                key={line.key}
                className="platter-console__line"
                data-stream={line.stream}
                data-origin={line.origin}
              >
                {line.timestamp && !hasOwnTimestamp(line.text) ? (
                  <span className="platter-console__time">{formatTime(line.timestamp)}</span>
                ) : null}
                {line.text}
              </span>
            ))}
          </span>
        )}
      </section>

      <HStack gap={2} align="end">
        <TextInput
          label="Command"
          isLabelHidden
          value={command}
          onChange={setCommand}
          placeholder={
            running ? 'say hello, whitelist add name, op name…' : 'Server is not running'
          }
          isDisabled={!running || sending}
          width="100%"
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
              return;
            }
            // Shell-style history, because the same three commands get run over and over.
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              const next = Math.min(historyIndex + 1, history.length - 1);
              if (next >= 0 && history[next] !== undefined) {
                setHistoryIndex(next);
                setCommand(history[next]);
              }
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              // Clamped at -1 — "no history entry selected". Without the floor, one ArrowDown
              // press on a fresh field takes the index to -2, and every subsequent ArrowUp
              // computes -1, fails its own `>= 0` guard, and leaves it there. History dies
              // permanently until the next command is submitted.
              const next = Math.max(historyIndex - 1, -1);
              setHistoryIndex(next);
              setCommand(next >= 0 ? (history[next] ?? '') : '');
            }
          }}
        />
        <Button
          label="Send"
          variant="primary"
          isDisabled={!running || command.trim().length === 0}
          isLoading={sending}
          onClick={() => void submit()}
        />
      </HStack>
    </VStack>
  );
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Minecraft's own log format already opens with `[HH:mm:ss INFO]`, and the itzg entrypoint
 * prefixes its lines similarly. Rendering Docker's timestamp alongside produces every line
 * stamped twice, a few characters apart, which is both noisy and mildly confusing — the two
 * clocks are not guaranteed to agree.
 */
const OWN_TIMESTAMP = /^\s*\[\d{2}:\d{2}:\d{2}/;

function hasOwnTimestamp(text: string): boolean {
  return OWN_TIMESTAMP.test(text);
}
