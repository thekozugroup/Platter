import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { API_PREFIX } from '@platter/shared';
import { config } from './config.js';
import { attachDatabaseLogging } from './db.js';
import { buildLoggerOptions, genReqId } from './logger.js';
import authPlugin from './plugins/auth.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import openapiPlugin from './plugins/openapi.js';
import securityPlugin, { BODY_LIMIT_BYTES } from './plugins/security.js';
import consoleRoutes from './routes/console.js';
import routes from './routes/index.js';
import spaPlugin from './plugins/spa.js';
import { httpMetricsPlugin } from './services/metrics.js';

export interface BuildAppOptions {
  /** Tests pass false; `buildLoggerOptions` already silences NODE_ENV=test. */
  logger?: boolean;
}

/**
 * Builds a fully wired, not-yet-listening Fastify instance.
 *
 * Tests drive this through `app.inject`, so nothing here may depend on a socket, on the
 * Docker daemon, or on the process having started.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : buildLoggerOptions(),
    // Fastify would otherwise take the client's header verbatim; genReqId validates it
    // first, because the id is echoed into responses and log lines.
    requestIdHeader: false,
    genReqId,
    trustProxy: config.trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    routerOptions: {
      // `/servers` and `/servers/` are the same endpoint; a trailing slash from a client
      // is not worth a 404.
      ignoreTrailingSlash: true,
    },
  });

  // This pair is what makes `.withTypeProvider<ZodTypeProvider>()` work in every route
  // module: zod schemas become both the runtime validator and the response serialiser.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  attachDatabaseLogging(app.log);

  // Order matters. The error handler goes first so a failure inside any later plugin is
  // already rendered as the standard envelope; security before the docs and routes so
  // headers and limits cover them too; swagger before routes because it collects them
  // through an onRoute hook.
  await app.register(errorHandlerPlugin);
  // At the root, and before the routes exist: an `onResponse` hook only observes traffic
  // in the encapsulation context it was added to, so registering this inside any nested
  // plugin would silently measure a fraction of the requests. It declares skip-override
  // for exactly that reason.
  if (config.metricsEnabled) await app.register(httpMetricsPlugin);
  await app.register(securityPlugin);
  await app.register(openapiPlugin);
  await app.register(authPlugin);
  await app.register(routes, { prefix: API_PREFIX });
  // Outside the API prefix on purpose: `WS_PATH` is an absolute path, and the browser
  // client builds its URL from the origin plus that constant, not from the REST base.
  await app.register(consoleRoutes);
  // Last, so it can never shadow a route: the static handler and the client-router fallback
  // both resolve only what nothing above claimed.
  await app.register(spaPlugin);

  return app;
}
