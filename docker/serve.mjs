#!/usr/bin/env node
/**
 * Container entrypoint.
 *
 * Next's standalone server reads `HOSTNAME` and `PORT` — its own names. Platter's are
 * `PLATTER_HOST` and `PLATTER_PORT`, and those are what the config schema states the token
 * requirement in terms of, what the settings page shows the user, and what an operator will
 * naturally override in `compose.yaml`. Without this mapping, overriding them changes what
 * Platter *says* about itself and nothing about what it binds, which is the failure mode that
 * makes a security invariant decorative.
 *
 * The Dockerfile sets both pairs to matching defaults; this keeps them matching when only one is
 * overridden.
 */
import { pathToFileURL } from 'node:url';

const host = process.env.PLATTER_HOST?.trim() || '0.0.0.0';
const port = process.env.PLATTER_PORT?.trim() || '4880';

process.env.HOSTNAME = host;
process.env.PORT = port;

await import(pathToFileURL(new URL('../apps/web/server.js', import.meta.url).pathname).href);
