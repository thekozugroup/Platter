import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Route outbound HTTP through the proxy the environment asks for.
 *
 * Node's global `fetch` **ignores `HTTP_PROXY` / `HTTPS_PROXY` entirely** — unlike curl, git,
 * npm and essentially every other tool an operator has configured. Without this, a Platter
 * behind a corporate egress proxy reaches nothing: mod search returns `service_unavailable`,
 * AI features look unconfigured, and nothing in the logs points at the proxy as the cause,
 * because from Node's side the connection simply failed.
 *
 * `EnvHttpProxyAgent` reads `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (either case) with the
 * conventional semantics, so an operator configures Platter the same way they configure
 * everything else on the box.
 *
 * Called once at startup, before anything makes a request.
 */

/** True when the environment asks for a proxy at all. */
export function proxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HTTP_PROXY ?? env.http_proxy ?? env.HTTPS_PROXY ?? env.https_proxy);
}

/**
 * Installs the proxy-aware dispatcher. Returns the previous one so a test can restore it.
 *
 * A malformed proxy URL must not stop the server booting: every outbound call is optional
 * (mods, AI), while the panel itself is not, so a bad value is logged loudly and the default
 * dispatcher is left in place.
 */
export function configureHttpProxy(logger: FastifyBaseLogger): void {
  if (!proxyConfigured()) return;

  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    logger.info(
      {
        httpProxy: redactProxyUrl(process.env.HTTP_PROXY ?? process.env.http_proxy),
        httpsProxy: redactProxyUrl(process.env.HTTPS_PROXY ?? process.env.https_proxy),
        noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? null,
      },
      'routing outbound HTTP through the configured proxy',
    );
  } catch (error) {
    logger.error(
      { err: error },
      'the configured HTTP proxy could not be used; outbound requests will go direct',
    );
  }
}

/** Restores a dispatcher captured before `configureHttpProxy`. Test helper. */
export function currentDispatcher(): ReturnType<typeof getGlobalDispatcher> {
  return getGlobalDispatcher();
}

/**
 * Proxy URLs routinely carry credentials, and this value is logged at startup where an
 * operator will paste it into a bug report.
 */
function redactProxyUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString();
  } catch {
    return '(unparseable)';
  }
}
