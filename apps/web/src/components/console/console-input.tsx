import { useCallback, useId, useRef, useState } from 'react';
import type { ServerStatus } from '@platter/shared';
import { LIMITS, isLocked } from '@platter/shared';
import { Send } from 'pixelarticons/react/Send.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SERVER_STATUS_LABELS } from '@/components/common/status-pill';
import { useLocalStorage } from '@/hooks/use-local-storage.js';
import type { ConnectionState } from '@/lib/console-socket.js';
import { cn } from '@/lib/utils';

/**
 * The console command line.
 *
 * The interesting part is the disabled path, not the happy one. There are four separate
 * reasons this input can refuse a command — no permission, no connection, the server is not
 * running, the server is locked mid-install — and they need different answers. A greyed-out
 * box with no explanation is the single most common dead end in a panel like this, so the
 * reason is always written underneath and wired to the field with `aria-describedby`.
 *
 * History is per-server and survives a reload, because the command you want next is almost
 * always the one you ran last time.
 */

/** Deep enough to find the command you ran an hour ago, shallow enough to stay a UI concern. */
const HISTORY_LIMIT = 50;

export interface ConsoleInputProps {
  /** Sends the command. Returns false when the socket refused it, which surfaces as an error. */
  onSubmit: (command: string) => boolean;
  /** Whether this principal holds `console.write` on this server. */
  canWrite: boolean;
  connectionState: ConnectionState;
  /** The live status from the socket, falling back to the server record. */
  serverStatus: ServerStatus | null;
  serverId: string;
  serverName: string;
  className?: string;
}

/**
 * Why the command line is closed right now, or `null` when it is open.
 *
 * Ordered by what the operator can act on: a permission problem is permanent until someone
 * changes it, a connection problem fixes itself, and a stopped server just needs starting.
 */
export function consoleInputBlockedReason(
  canWrite: boolean,
  connectionState: ConnectionState,
  status: ServerStatus | null,
): string | null {
  if (connectionState === 'connecting' || connectionState === 'authenticating') {
    return 'Connecting to the console. The command line opens as soon as it is live.';
  }
  if (connectionState === 'reconnecting') {
    return 'Reconnecting to the console. The command line reopens once it is live.';
  }
  if (connectionState === 'closed') {
    return 'The console is not connected.';
  }
  if (!canWrite) {
    return 'You can read this console but not write to it. Ask the owner for the console.write permission.';
  }
  if (status === null) return 'Waiting for the server to report its status.';
  if (status === 'running') return null;
  if (status === 'starting') {
    return 'The server is still booting. It accepts commands once it reports running.';
  }
  if (isLocked(status)) {
    return `Not while it is ${SERVER_STATUS_LABELS[status].toLowerCase()}. There is no game process to talk to yet.`;
  }
  return `The server is ${SERVER_STATUS_LABELS[status].toLowerCase()}. Start it to send commands.`;
}

export function ConsoleInput({
  onSubmit,
  canWrite,
  connectionState,
  serverStatus,
  serverId,
  serverName,
  className,
}: ConsoleInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();
  const errorId = useId();

  const [history, setHistory] = useLocalStorage<string[]>(
    `platter.console.history.${serverId}`,
    [],
  );
  const [draft, setDraft] = useState('');
  /** -1 means "typing a new command"; 0 is the most recent entry. */
  const [historyIndex, setHistoryIndex] = useState(-1);
  /** What was being typed before arrowing into history, so Down restores it. */
  const [stashed, setStashed] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reason = consoleInputBlockedReason(canWrite, connectionState, serverStatus);
  const disabled = reason !== null;

  const recall = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0) {
        setHistoryIndex(-1);
        setDraft(stashed);
        return;
      }
      const clamped = Math.min(nextIndex, history.length - 1);
      const entry = history[clamped];
      if (entry === undefined) return;
      if (historyIndex === -1) setStashed(draft);
      setHistoryIndex(clamped);
      setDraft(entry);
    },
    [draft, history, historyIndex, stashed],
  );

  const submit = useCallback(() => {
    const command = draft.trim();
    if (command.length === 0) return;

    const accepted = onSubmit(command);
    if (!accepted) {
      setError('That command was not sent — the console is not accepting input right now.');
      return;
    }

    setError(null);
    // Newest first, de-duplicated against the immediately previous command so holding
    // Enter on `list` does not fill the history with one word.
    setHistory((previous) =>
      [command, ...previous.filter((entry, index) => !(index === 0 && entry === command))].slice(
        0,
        HISTORY_LIMIT,
      ),
    );
    setDraft('');
    setStashed('');
    setHistoryIndex(-1);
  }, [draft, onSubmit, setHistory]);

  return (
    <form
      className={cn('flex flex-col gap-2', className)}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-end gap-2">
        <div className="relative min-w-0 flex-1">
          <label className="sr-only" htmlFor={`${hintId}-input`}>
            {`Send a command to ${serverName}`}
          </label>
          {/* The prompt marker is decorative; the label above is the real accessible name. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-s-3 top-1/2 -translate-y-1/2 font-mono text-footnote text-label-tertiary"
          >
            &gt;
          </span>
          <Input
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            aria-invalid={error !== null}
            autoComplete="off"
            autoCorrect="off"
            className="h-11 w-full ps-7 font-mono text-footnote"
            disabled={disabled}
            id={`${hintId}-input`}
            maxLength={LIMITS.maxConsoleLineLength}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                recall(historyIndex + 1);
                return;
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                recall(historyIndex - 1);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft('');
                setHistoryIndex(-1);
                setStashed('');
              }
            }}
            placeholder={disabled ? '' : 'list  ·  ↑ for history'}
            ref={inputRef}
            spellCheck={false}
            value={draft}
          />
        </div>

        <Button
          aria-describedby={disabled ? hintId : undefined}
          className="h-11 rounded-button px-5 text-subhead font-medium"
          disabled={disabled || draft.trim().length === 0}
          size="lg"
          type="submit"
        >
          <Send aria-hidden />
          Send
        </Button>
      </div>

      {/*
        One line that is either the reason the field is shut or a reminder of what the field
        does. It is always present, so the layout never jumps when the server changes state.
      */}
      <p
        className={cn('text-caption', disabled ? 'text-label-secondary' : 'text-label-tertiary')}
        id={hintId}
      >
        {reason ??
          `Commands go straight to ${serverName}’s process, exactly as if you typed them at its terminal.`}
      </p>

      {error ? (
        <p className="text-caption text-danger" id={errorId} role="alert">
          {error}
        </p>
      ) : null}

      {/* Announces the reason changing while focus stays in the field. */}
      <span aria-live="polite" className="sr-only" role="status">
        {disabled ? `Command line unavailable. ${reason}` : 'Command line ready.'}
      </span>
    </form>
  );
}
