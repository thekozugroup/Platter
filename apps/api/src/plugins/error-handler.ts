import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ERROR_MESSAGES, PlatterError, type ErrorCode } from '@platter/shared';
import { REQUEST_ID_HEADER } from '../logger.js';
import { isPrismaKnownError, fromPrismaError, zodDetails } from '../lib/errors.js';

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
      return reply.status(platterError.status).send(platterError.toBody(requestId));
    }

    // Schema validation on the way out is *our* bug, not the caller's: the handler
    // produced something its own response schema forbids. Never describe it to a client.
    // The code is checked first because the library's own predicate is a loose duck-type
    // that would claim any error carrying a `method` property.
    if (error.code === 'FST_ERR_RESPONSE_SERIALIZATION' && isResponseSerializationError(error)) {
      request.log.error({ err: error, issues: error.cause.issues }, 'response failed its schema');
      const platterError = new PlatterError('internal_error', ERROR_MESSAGES.internal_error);
      return reply.status(500).send(platterError.toBody(requestId));
    }

    if (error instanceof PlatterError) {
      // 5xx means something on our side broke; 4xx is the caller being told no, which is
      // ordinary traffic and would drown the log at error level.
      const context = { err: error, code: error.code };
      if (error.status >= 500) request.log.error(context, error.message);
      else request.log.warn(context, error.message);
      return reply.status(error.status).send(error.toBody(requestId));
    }

    if (error instanceof z.ZodError) {
      const platterError = new PlatterError('validation_failed', ERROR_MESSAGES.validation_failed, {
        details: zodDetails(error),
      });
      return reply.status(platterError.status).send(platterError.toBody(requestId));
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
      return reply.status(platterError.status).send(platterError.toBody(requestId));
    }

    const status = statusCodeOf(error);
    if (status !== null && status < 500) {
      const code = STATUS_CODES[status] ?? 'bad_request';
      request.log.warn({ err: error }, 'request rejected before the handler');
      // Fastify's own messages are safe and specific ("Request body is too large"), so
      // they are worth passing through where they exist.
      const message = error.message.length > 0 ? error.message : ERROR_MESSAGES[code];
      return reply.status(status).send(new PlatterError(code, message).toBody(requestId));
    }

    // Anything left is unexpected. The real error is logged; the client gets a request id
    // to quote and nothing that describes our internals.
    request.log.error({ err: error }, 'unhandled error');
    const platterError = new PlatterError('internal_error', ERROR_MESSAGES.internal_error);
    return reply.status(500).send(platterError.toBody(requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    const platterError = new PlatterError(
      'not_found',
      `No route for ${request.method} ${request.url}.`,
    );
    return reply.status(404).send(platterError.toBody(request.id));
  });
};

export default Object.assign(errorHandlerPlugin, {
  // Same marker `fastify-plugin` sets (it is not a dependency here). Without it the error
  // handler would only cover this plugin's own — empty — encapsulation context.
  [Symbol.for('skip-override')]: true,
});
