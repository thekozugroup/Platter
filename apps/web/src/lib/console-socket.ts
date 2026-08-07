import {
  serverMessageSchema,
  WS_CLOSE,
  type ClientMessage,
  type LogLine,
  type ServerMessage,
  type ServerStats,
  type ServerStatus,
} from '@platter/shared';
import { api } from './api-client.js';
import { backoffDelay } from './utils.js';

/**
 * Client for the console WebSocket.
 *
 * Kept out of React on purpose: a socket that lives in a component's lifecycle gets torn
 * down and rebuilt by every re-render and every StrictMode double-mount, which in practice
 * means dropped log lines and a reconnect storm. This owns the connection; hooks subscribe.
 */

export type ConnectionState = 'connecting' | 'authenticating' | 'open' | 'reconnecting' | 'closed';

export interface ConsoleSocketHandlers {
  onLog?: (line: LogLine) => void;
  onBacklog?: (lines: LogLine[]) => void;
  onStatus?: (status: ServerStatus, exitCode: number | null) => void;
  onStats?: (stats: ServerStats) => void;
  onStateChange?: (state: ConnectionState, detail?: { canWrite: boolean }) => void;
  onError?: (message: string) => void;
}

const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
/** Two missed pongs is a dead socket — the server heartbeats well inside this. */
const PONG_TIMEOUT_MS = 60_000;

export class ConsoleSocket {
  #serverId: string;
  #handlers: ConsoleSocketHandlers;
  #socket: WebSocket | null = null;
  #state: ConnectionState = 'closed';
  #attempt = 0;
  #closedByUs = false;
  #canWrite = false;

  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #authTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(serverId: string, handlers: ConsoleSocketHandlers) {
    this.#serverId = serverId;
    this.#handlers = handlers;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get canWrite(): boolean {
    return this.#canWrite;
  }

  connect(): void {
    this.#closedByUs = false;
    this.#open();
  }

  #open(): void {
    this.#clearTimers();

    const token = api.accessToken;
    if (!token) {
      // No token yet — the auth store is still restoring. Retry rather than failing hard.
      this.#scheduleReconnect();
      return;
    }

    this.#setState('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/servers/${encodeURIComponent(this.#serverId)}/console`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#setState('authenticating');
      // The token goes in the first frame, never the URL — query strings land in
      // proxy access logs and browser history.
      this.#send({ type: 'auth', token });
      this.#authTimer = setTimeout(() => {
        this.#handlers.onError?.('The console did not respond. Reconnecting.');
        socket.close();
      }, AUTH_TIMEOUT_MS);
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;

      let parsed: ServerMessage;
      try {
        const result = serverMessageSchema.safeParse(JSON.parse(event.data));
        if (!result.success) return;
        parsed = result.data;
      } catch {
        return;
      }

      this.#handleMessage(parsed);
    });

    socket.addEventListener('close', (event) => {
      this.#clearTimers();
      this.#socket = null;

      if (this.#closedByUs) {
        this.#setState('closed');
        return;
      }

      // Auth failures are terminal: reconnecting with the same bad token just loops.
      // Everything else — including a normal close from a server restart — retries.
      if (event.code === WS_CLOSE.unauthorized || event.code === WS_CLOSE.forbidden) {
        this.#handlers.onError?.('You do not have access to this console.');
        this.#setState('closed');
        return;
      }
      if (event.code === WS_CLOSE.gone) {
        this.#setState('closed');
        return;
      }
      if (event.code === WS_CLOSE.tooManyConnections) {
        this.#handlers.onError?.('Too many open consoles. Close one and try again.');
        this.#setState('closed');
        return;
      }

      this.#scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // The close event always follows; reconnect logic lives there to avoid doubling up.
    });
  }

  #handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'ready': {
        if (this.#authTimer) clearTimeout(this.#authTimer);
        this.#attempt = 0;
        this.#canWrite = message.canWrite;
        this.#setState('open', { canWrite: message.canWrite });
        this.#handlers.onStatus?.(message.status, null);
        this.#startHeartbeat();
        break;
      }
      case 'log':
        this.#handlers.onLog?.(message.line);
        break;
      case 'logs':
        this.#handlers.onBacklog?.(message.lines);
        break;
      case 'status':
        this.#handlers.onStatus?.(message.status, message.exitCode);
        break;
      case 'stats':
        this.#handlers.onStats?.(message.stats);
        break;
      case 'error':
        this.#handlers.onError?.(message.message);
        break;
      case 'pong':
        this.#armPongTimeout();
        break;
    }
  }

  #startHeartbeat(): void {
    this.#pingTimer = setInterval(() => this.#send({ type: 'ping' }), PING_INTERVAL_MS);
    this.#armPongTimeout();
  }

  /**
   * A TCP connection can die without either side noticing — a laptop lid closing, a NAT
   * timeout. Without this the UI shows a live console that will never update again.
   */
  #armPongTimeout(): void {
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#pongTimer = setTimeout(() => {
      this.#socket?.close();
    }, PONG_TIMEOUT_MS);
  }

  #scheduleReconnect(): void {
    if (this.#closedByUs) return;
    this.#setState('reconnecting');
    const delay = backoffDelay(this.#attempt);
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  #setState(state: ConnectionState, detail?: { canWrite: boolean }): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#handlers.onStateChange?.(state, detail);
  }

  #send(message: ClientMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }

  /** Returns false when the socket is not writable, so the UI can say why. */
  sendCommand(command: string): boolean {
    if (this.#state !== 'open' || !this.#canWrite) return false;
    this.#send({ type: 'command', command });
    return true;
  }

  requestBacklog(lines = 200): void {
    this.#send({ type: 'backlog', lines });
  }

  #clearTimers(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#authTimer) clearTimeout(this.#authTimer);
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#reconnectTimer = undefined;
    this.#authTimer = undefined;
    this.#pingTimer = undefined;
    this.#pongTimer = undefined;
  }

  close(): void {
    this.#closedByUs = true;
    this.#clearTimers();
    this.#socket?.close(1000, 'client closed');
    this.#socket = null;
    this.#setState('closed');
  }
}
