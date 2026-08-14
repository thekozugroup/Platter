import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import { API_PREFIX, API_VERSION } from '@platter/shared';

const DESCRIPTION = [
  'Control plane for Platter game servers.',
  '',
  'Authenticate either with a bearer access token (obtained from `POST /auth/login` and',
  'refreshed via the `platter_refresh` cookie) or with a long-lived API key in the',
  '`X-API-Key` header. Every failure returns the same envelope:',
  '`{ "error": { "code", "message", "details?", "requestId?" } }` — switch on `code`, not',
  'on the message.',
].join('\n');

const openapiPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Platter API',
        version: API_VERSION,
        description: DESCRIPTION,
      },
      servers: [{ url: API_PREFIX, description: 'This deployment' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Short-lived access token held in memory by the web client.',
          },
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
            description:
              'Long-lived key of the form `plt_xxxxxxxx.<secret>`, shown once at creation.',
          },
        },
      },
      // Either scheme satisfies the requirement; routes that need neither opt out with
      // `security: []` in their own schema.
      security: [{ bearerAuth: [] }, { apiKey: [] }],
    },
    // The zod schemas on each route are the spec — there is no second, hand-written
    // description of the API to drift out of date.
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
    // Lets the UI declare the exact hashes its own assets need instead of the application
    // CSP having to be loosened for them.
    staticCSP: true,
  });
};

export default Object.assign(openapiPlugin, {
  // Same marker `fastify-plugin` sets (it is not a dependency here). @fastify/swagger
  // collects routes through an onRoute hook, which only fires for routes registered in
  // the context it lives in — so it has to live in the root one.
  [Symbol.for('skip-override')]: true,
});
