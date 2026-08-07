import { z } from 'zod';
import { SERVER_STATUSES } from './domain.js';
import { serverStatsSchema } from './schemas/server.js';

/**
 * The console socket protocol.
 *
 * One socket per server carries logs, status transitions and stats. Messages are
 * discriminated on `type`, and both ends parse with these schemas, so a protocol change
 * is a type error rather than a silent no-op.
 */

export const WS_PATH = '/ws/servers/:serverId/console';

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('type', [
  /** Sent immediately after the socket opens; the server replies with `ready`. */
  z.object({ type: z.literal('auth'), token: z.string() }),
  z.object({ type: z.literal('command'), command: z.string().min(1).max(2000) }),
  /** Ask for scrollback the client does not have yet. */
  z.object({ type: z.literal('backlog'), lines: z.number().int().min(1).max(2000).default(200) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const logLineSchema = z.object({
  /** Monotonic per-connection sequence number; lets the client detect dropped frames. */
  seq: z.number().int(),
  /** `stdout` | `stderr` | `system` — system lines are Platter's own annotations. */
  stream: z.enum(['stdout', 'stderr', 'system']),
  content: z.string(),
  timestamp: z.string(),
});
export type LogLine = z.infer<typeof logLineSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    serverId: z.string(),
    status: z.enum(SERVER_STATUSES),
    /** Permissions this socket's principal holds, so the UI can disable console input. */
    canWrite: z.boolean(),
  }),
  z.object({ type: z.literal('log'), line: logLineSchema }),
  /** Batched scrollback delivered in one frame on connect. */
  z.object({ type: z.literal('logs'), lines: z.array(logLineSchema) }),
  z.object({
    type: z.literal('status'),
    status: z.enum(SERVER_STATUSES),
    /** Populated on transitions into `crashed`. */
    exitCode: z.number().int().nullable().default(null),
  }),
  z.object({ type: z.literal('stats'), stats: serverStatsSchema }),
  /** Non-fatal problem — shown as a toast, socket stays open. */
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Close codes carrying meaning beyond the RFC set. */
export const WS_CLOSE = {
  /** Token missing, invalid or expired — the client should refresh and retry once. */
  unauthorized: 4401,
  /** Authenticated, but not permitted to view this server's console. */
  forbidden: 4403,
  /** The server was deleted while the socket was open. */
  gone: 4404,
  /** No `auth` frame arrived in time. */
  authTimeout: 4408,
  /** Too many sockets from this principal. */
  tooManyConnections: 4429,
  /** Platter is shutting down; the client should reconnect with backoff. */
  shuttingDown: 4503,
} as const;

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];
