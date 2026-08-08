import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LogLine, Server, ServerStats, ServerStatus } from '@platter/shared';
import { ConsoleSocket, type ConnectionState } from '@/lib/console-socket.js';
import { queryKeys } from '@/lib/query.js';
// `throttle` does not exist yet in `lib/utils.ts` (owned outside this file's scope) — see
// the assumptions in this hook's report. Everything here is written against the contract
// the rest of the codebase already assumes for it: `throttle(fn, waitMs) => fn`.
import { throttle } from '@/lib/utils.js';

/**
 * The console screen's one hook. One `ConsoleSocket` per `serverId`, created in a ref so a
 * re-render never tears it down, torn down for real only on unmount or when `serverId`
 * changes. A server logging thousands of lines a minute must produce one batched render
 * every `FLUSH_INTERVAL_MS`, not one render per line — that is what `throttle` buys here.
 */

/** Kept above the API's own scrollback (`LIMITS.consoleScrollback`, 500) so a full backlog
 *  fetch plus a burst of live lines does not immediately evict the backlog that just arrived. */
const LINE_BUFFER_CAP = 2000;
const FLUSH_INTERVAL_MS = 150;

export interface UseConsoleResult {
  lines: LogLine[];
  connectionState: ConnectionState;
  serverStatus: ServerStatus | null;
  lastExitCode: number | null;
  /** Whether this socket is currently allowed to send commands (permission, not connection). */
  canWrite: boolean;
  stats: ServerStats | null;
  /** A non-fatal problem reported by the socket (e.g. "too many open consoles"). */
  notice: string | null;
  dismissNotice: () => void;
  /** False when the socket cannot accept input right now (disconnected or read-only). */
  sendCommand: (command: string) => boolean;
  requestBacklog: (lines?: number) => void;
  /** Clears the on-screen buffer without touching the connection. */
  clear: () => void;
}

export function useConsole(serverId: string): UseConsoleResult {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pendingRef = useRef<LogLine[]>([]);
  const mountedRef = useRef(true);
  const socketRef = useRef<ConsoleSocket | null>(null);

  // Stable for the component's lifetime: recreating the throttle on every render would
  // reset its window and defeat the batching.
  const flush = useMemo(
    () =>
      throttle(() => {
        if (!mountedRef.current || pendingRef.current.length === 0) return;
        const incoming = pendingRef.current;
        pendingRef.current = [];
        setLines((previous) => {
          const merged = previous.length === 0 ? incoming : previous.concat(incoming);
          return merged.length > LINE_BUFFER_CAP ? merged.slice(merged.length - LINE_BUFFER_CAP) : merged;
        });
      }, FLUSH_INTERVAL_MS),
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    pendingRef.current = [];
    setLines([]);
    setServerStatus(null);
    setLastExitCode(null);
    setStats(null);
    setNotice(null);
    setCanWrite(false);

    const socket = new ConsoleSocket(serverId, {
      onLog: (line) => {
        pendingRef.current.push(line);
        flush();
      },
      onBacklog: (backlog) => {
        pendingRef.current.push(...backlog);
        flush();
      },
      onStatus: (status, exitCode) => {
        setServerStatus(status);
        setLastExitCode(exitCode);
        // Keeps every other screen reading this server's status (the header pill, the
        // dashboard grid) in sync without waiting for their own next poll.
        queryClient.setQueryData<Server>(queryKeys.servers.detail(serverId), (previous) =>
          previous ? { ...previous, status } : previous,
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.servers.all });
      },
      onStats: (nextStats) => {
        setStats(nextStats);
        queryClient.setQueryData(queryKeys.servers.stats(serverId), nextStats);
      },
      onStateChange: (state, detail) => {
        setConnectionState(state);
        setCanWrite(state === 'open' ? (detail?.canWrite ?? false) : false);
      },
      onError: (message) => setNotice(message),
    });

    socketRef.current = socket;
    socket.connect();

    return () => {
      mountedRef.current = false;
      socket.close();
      socketRef.current = null;
    };
  }, [serverId, queryClient, flush]);

  const sendCommand = useCallback(
    (command: string) => socketRef.current?.sendCommand(command) ?? false,
    [],
  );
  const requestBacklog = useCallback((count?: number) => socketRef.current?.requestBacklog(count), []);
  const clear = useCallback(() => setLines([]), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    lines,
    connectionState,
    serverStatus,
    lastExitCode,
    canWrite,
    stats,
    notice,
    dismissNotice,
    sendCommand,
    requestBacklog,
    clear,
  };
}
