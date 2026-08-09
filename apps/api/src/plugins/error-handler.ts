import type { FastifyError, FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ERROR_MESSAGES, PlatterError, type ApiErrorBody, type ErrorCode } from '@platter/shared';
import { REQUEST_ID_HEADER } from '../logger.js';
import { isPrismaKnownError, fromPrismaError, zodDetails } from '../lib/errors.js';
import { sendAppShell, wantsAppShell } from './spa.js';

/**
 * Statuses Fastify itself produces before a route ever runs — body too large, bad
 * content-type, rate limit. Mapping them keeps the error envelope uniform: a client only
 * ever has to understand one response shape.
 */
const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'bad_request',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  503: 'service_unavailable',
};

/** `/limits/memoryMb` -> `limits.memoryMb`, the dotted form `ApiErrorBody.details` uses. */
function dottedPath(instancePath: string): string {
  const trimmed = instancePath.replace(/^\//, '');
  return trimmed.length > 0 ? trimmed.replaceAll('/', '.') : '_';
}

function statusCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : null;
}

/**
 * Sends an error envelope, bypassing whatever response schema the route declared.
 *
 * This is not a shortcut — it is required for correctness. Fastify serialises a reply
 * against `schema.response[statusCode]`, and a handful of routes legitimately declare a
 * body for a 4xx/5xx status (`proposals` returns the approval outcome with 409;
 * `/system/ready` returns the readiness report with 503). Without this, a `PlatterError`
 * that maps to one of those codes gets validated against that route's *success* shape,
 * fails, and is rewritten into a 500 — turning "that proposal was already failed" into
 * "internal error" and hiding the real cause.
 *
 * The envelope's shape is owned by `PlatterError.toBody`, is identical on every route, and
 * is already typed, so there is nothing a route schema could usefully check about it.
 */
function sendError(reply: FastifyReply, status: number, body: ApiErrorBody): FastifyReply {
  return reply
    .status(status)
    .type('application/json')
    .serializer((payload: unknown) => JSON.stringify(payload))
    .send(body);
}

const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  // Set on the way in rather than in the handler, so a successful response carries the
  // same correlation id the client would have seen on a failure.
  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    // Schema validation on the way in: the client sent something we can describe precisely.
    if (hasZodFastifySchemaValidationErrors(error)) {
      const details: Record<string, string[]> = {};
      for (const issue of error.validation) {
        const key = dottedPath(issue.instancePath);
        // `message` is optional on Fastify's validation error shape; zod always sets one,
        // but a fallback beats rendering "undefined" next to a form field.
        const message = issue.message ?? 'That value is not valid.';
        const existing = details[key];
        if (existing) existing.push(message);
        else details[key] = [message];
      }
      const platterError = new PlatterError('validation_failed', ERROR_MESSAGES.validation_failed, {
        details,
      });
      return sendError(reply, platterError.status, platterError.toBody(requestId));
    }

    // Schema validation on the way out is *our* bug, not the caller's: the handler
    // produced something its own response schema forbids. Never describe it to a client.
    // The code is checked first because the library's own predicate is a loose duck-type
    // that would claim any error carrying a `method` property.
    if (error.code === 'FST_ERR_RESPONSE_SERIALIZATION' && isResponseSerializationError(error)) {
      request.log.error({ err: error, issues: error.cause.issues }, 'response failed its schema');
      const platterError = new PlatterError('internal_error', ERROR_MESSAGES.internal_error);
      return sendError(reply, 500, platterError.toBody(requestId));
    }

    if (error instanceof PlatterError) {
      // 5xx means something on our side broke; 4xx is the caller being told no, which is
      // ordinary traffic and would drown the log at error level.
      const context = { err: error, code: error.code };
      if (error.status >= 500) request.log.error(context, error.message);
      else request.log.warn(context, error.message);
      return sendError(reply, error.status, error.toBody(requestId));
    }

    if (error instanceof z.ZodError) {
      const platterError = new PlatterError('validation_failed', ERROR_MESSAGES.validation_failed, {
        details: zodDetails(error),
      });
      return sendError(reply, platterError.status, platterError.toBody(requestId));
    }

    // Narrowed through a separate binding: the Prisma guard is structural, and letting it
    // narrow `error` itself would leave the branches below with nothing to work on.
    const unknownError: unknown = error;
    if (isPrismaKnownError(unknownError)) {
      const platterError = fromPrismaError(unknownError);
      // The Prisma message names tables and columns, so it goes to the log only.
      request.log.warn(
        { err: unknownError, prismaCode: unknownError.code },
        'database constraint rejected a write',
      );
      return sendError(reply, platterError.status, platterError.toBody(requestId));
    }

    const status = statusCodeOf(error);
    if (status !== null && status < 500) {
      const code = STATUS_CODES[status] ?? 'bad_request';
      request.log.warn({ err: error }, 'request rejected before the handler');
      // Fastify's own messages are safe and specific ("Request body is too large"), so
      // they are worth passing through where they exist.
      const message = error.message.length > 0 ? error.message : ERROR_MESSAGES[code];
      return sendError(reply, status, new PlatterError(code, message).toBody(requestId));
    }

    // Anything left is unexpected. The real error is logged; the client gets a request id
    // to quote and nothing that describes our internals.
    request.log.error({ err: error }, 'unhandled error');
    const platterError = new PlatterError('internal_error', ERROR_MESSAGES.internal_error);
    return sendError(reply, 500, platterError.toBody(requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    // A navigation to an unmatched path is a client-side route, not a mistake: the SPA and
    // the API share an origin, so a deep link pasted into a fresh tab arrives here. Anything
    // under /api, any non-GET, and any request that did not ask for HTML still gets the JSON
    // envelope — a client parsing an error must never receive a page.
    if (wantsAppShell(request)) return sendAppShell(reply);

    const platterError = new PlatterError(
      'not_found',
      `No route for ${request.method} ${request.url}.`,
    );
    return sendError(reply, 404, platterError.toBody(request.id));
  });
};

export default Object.assign(errorHandlerPlugin, {
  // Same marker `fastify-plugin` sets (it is not a dependency here). Without it the error
  // handler would only cover this plugin's own — empty — encapsulation context.
  [Symbol.for('skip-override')]: true,
});
