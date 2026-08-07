import type { FastifyServerOptions } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { ulid } from 'ulid';
import { config, isProduction, isTest } from './config.js';

/**
 * Paths scrubbed before anything is written. Credentials reach the logger through more
 * routes than you expect — a validation error echoing a body, a request log, a driver
 * error carrying its own headers — so redaction lives here rather than at each call site.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'totpSecret',
  'recoveryCodes',
  '*.password',
  '*.token',
  '*.passwordHash',
  '*.totpSecret',
];

/**
 * A client-supplied request id is echoed back and written into logs, so it is constrained
 * to a short, boring character set: an id is a correlation handle, not a place for a
 * caller to inject newlines into our log stream.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const REQUEST_ID_HEADER = 'x-request-id';

export function genReqId(request: IncomingMessage): string {
  const supplied = request.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
  if (candidate !== undefined && SAFE_REQUEST_ID.test(candidate)) return candidate;
  return `req_${ulid()}`;
}

/**
 * Logger configuration for `buildApp`. Pretty output is development-only: it costs a
 * worker thread and destroys machine parseability, both of which matter in production.
 */
export function buildLoggerOptions(): FastifyServerOptions['logger'] {
  if (isTest) return false;

  const base = {
    level: config.logLevel,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    serializers: {
      req(request: { id: string; method: string; url: string; ip?: string }) {
        return { id: request.id, method: request.method, url: request.url, ip: request.ip };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  };

  if (isProduction) return base;

  return {
    ...base,
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname', singleLine: false },
    },
  };
}
