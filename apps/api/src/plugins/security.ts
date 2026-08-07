import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit, { type RateLimitOptions } from '@fastify/rate-limit';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PlatterError } from '@platter/shared';
import { config, isProduction } from '../config.js';

/**
 * 2 MiB for JSON bodies. File uploads do not come through here — they stream via
 * multipart on the files routes, which set their own, much larger, limit.
 */
export const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Credential-guessing budget for the auth routes.
 *
 * The global limit is sized for a UI that polls; it is far too generous for a login form.
 * Ten attempts a minute per client is invisible to a human and useless to a password
 * sprayer. Applied per route, so burning the login bucket does not lock a user out of
 * refreshing an existing session.
 */
export const AUTH_RATE_LIMIT: RateLimitOptions = { max: 10, timeWindow: '1 minute' };

/** Even stricter for the endpoints that mint long-lived credentials. */
export const SENSITIVE_RATE_LIMIT: RateLimitOptions = { max: 5, timeWindow: '1 minute' };

/**
 * Buckets are keyed by API key where one is presented, so rotating source addresses does
 * not reset an automated caller's budget. Bearer tokens cannot be used here: this runs in
 * `onRequest`, long before `authenticate` has verified anything, and trusting an
 * unverified token as a bucket key would let a forged one share someone else's budget.
 */
function rateLimitKey(request: FastifyRequest): string {
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey === 'string') {
    const prefix = apiKey.split('.')[0];
    if (prefix) return `key:${prefix}`;
  }
  return `ip:${request.ip}`;
}

const securityPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        // The SPA bundle and the Swagger UI bundle are both same-origin. Swagger UI
        // injects its initialiser inline, which is why 'unsafe-inline' is present for
        // scripts; it is scoped by the same-origin default above.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        // Styled-in-JS and the docs UI both emit inline style attributes.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        // The console reads over a websocket on the same origin, under either scheme.
        connectSrc: ["'self'", 'ws:', 'wss:'],
        workerSrc: ["'self'", 'blob:'],
        formAction: ["'self'"],
      },
    },
    // Platter is a single-origin app; COEP would break the docs UI's own assets for no gain.
    crossOriginEmbedderPolicy: false,
    // HSTS is only meaningful once TLS is terminated in front of us.
    hsts: isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  await app.register(fastifyCors, {
    // An empty allowlist means same-origin only, which is the default deployment: the SPA
    // is served by this process. Reflecting arbitrary origins with credentials on would be
    // a session-theft hole, so there is no wildcard path here.
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  await app.register(fastifyRateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
    // The plugin *throws* whatever this returns, so it has to be an Error — returning a
    // plain body object lands in the catch-all 500 branch of the error handler instead.
    // A PlatterError carries its own status and renders the standard envelope, so a
    // throttled client parses the same shape as every other failure.
    errorResponseBuilder: (_request, context) =>
      context.statusCode === 403
        ? new PlatterError('forbidden', 'Blocked for repeatedly exceeding the rate limit.')
        : new PlatterError('rate_limited', `Too many requests. Try again in ${context.after}.`),
  });
};

export default Object.assign(securityPlugin, {
  // Same marker `fastify-plugin` sets (it is not a dependency here), so helmet's headers,
  // CORS and the rate limiter apply to every route rather than to this empty context.
  [Symbol.for('skip-override')]: true,
});
