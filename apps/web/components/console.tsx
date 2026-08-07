'use client';

import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useToast } from '@astryxdesign/core/Toast';
import type { ServerStatus } from '@platter/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sendCommandAction } from '@/lib/actions';

interface LogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  timestamp: number | undefined;
  text: string;
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
export function Console({
  serverId,
  status,
}: {
  serverId: string;
  status: ServerStatus;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [follow, setFollow] = useState(true);
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const scroller = useRef<HTMLDivElement | null>(null);
  const showToast = useToast();

  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) {
        return;
      }
      source = new EventSource(`/api/servers/${serverId}/logs?tail=400`);

      source.addEventListener('open', () => {
        attempt = 0;
        setConnected(true);
      });

      source.addEventListener('line', (event) => {
        const line = JSON.parse((event as MessageEvent<string>).data) as LogLine;
        setLines((current) => {
          const next = current.length >= MAX_LINES ? current.slice(-MAX_LINES + 1) : current;
          return [...next, line];
        });
      });

      source.addEventListener('error', () => {
        setConnected(false);
        source?.close();
        if (closed) {
          return;
        }
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
  }, [serverId]);

  // Stick to the bottom only while the user is already there. Yanking them back down mid-read
  // makes the console unusable exactly when they are trying to read an error.
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
          seq: Number.MAX_SAFE_INTEGER - current.length,
          stream: 'stdout',
          timestamp: Date.now(),
          text: `> ${trimmed}\n${result.response}`,
        },
      ]);
    }
  }, [command, sending, serverId, showToast]);

  const running = status === 'running' || status === 'unhealthy' || status === 'starting';

  return (
    <VStack gap={3} minHeight={0}>
      <HStack justify="between" align="center" gap={3} wrap="wrap">
        <Text type="supporting">
          {connected
            ? `Streaming · ${lines.length} line${lines.length === 1 ? '' : 's'}`
            : running
              ? 'Reconnecting…'
              : 'Not running. Showing the last output before it stopped.'}
        </Text>
        <HStack gap={3} align="center">
          <Switch
            label="Follow output"
            value={follow}
            onChange={setFollow}
            size="sm"
          />
          <Button label="Clear" variant="ghost" size="sm" onClick={() => setLines([])} />
        </HStack>
      </HStack>

      <section
        className="platter-console"
        ref={scroller}
        onScroll={onScroll}
        aria-label="Server console output"
        aria-live="polite"
      >
        {lines.length === 0 ? (
          <Text type="supporting">Waiting for output…</Text>
        ) : (
          lines.map((line) => (
            <span key={line.seq} className="platter-console__line" data-stream={line.stream}>
              {line.timestamp && !hasOwnTimestamp(line.text) ? (
                <span className="platter-console__time">{formatTime(line.timestamp)}</span>
              ) : null}
              {line.text}
            </span>
          ))
        )}
      </section>

      <HStack gap={2} align="end">
        <TextInput
          label="Command"
          isLabelHidden
          value={command}
          onChange={setCommand}
          placeholder={running ? 'say hello, whitelist add name, op name…' : 'Server is not running'}
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
              const next = historyIndex - 1;
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
