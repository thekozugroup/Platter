#!/usr/bin/env node
/**
 * Start Next on the address Platter says it is on.
 *
 * `next dev` and `next start` default their hostname to 0.0.0.0 and read only `PORT` from the
 * environment — there is no `HOSTNAME` fallback in the CLI. So `"dev": "next dev"` listens on
 * every interface no matter what `PLATTER_HOST` says, and the token requirement in the config
 * schema ("not loopback? then set PLATTER_AUTH_TOKEN") becomes a statement about a variable that
 * binds nothing. Following the README on a laptop then puts Docker-socket-level control of the
 * machine on the coffee-shop Wi-Fi, while the settings page reassures the user it is local-only.
 *
 * This is a launcher rather than a shell fragment in `package.json` because `${VAR:-default}` is
 * not portable to Windows, and this is the one place where getting it wrong is silently fatal.
 * The defaults are duplicated from the config schema deliberately: importing it would pull
 * TypeScript and Node built-ins into a script that has to run before any of the build tooling.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') {
  process.stderr.write('usage: serve.mjs <dev|start> [next options]\n');
  process.exit(2);
}

const host = process.env.PLATTER_HOST?.trim() || '127.0.0.1';
const port = process.env.PLATTER_PORT?.trim() || '4880';

// Next's own names, for anything downstream that reads them rather than the CLI flags.
process.env.HOSTNAME = host;
process.env.PORT = port;

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

// Run in this process rather than spawning: no second PID to forward SIGTERM through, which
// matters because the supervisor's shutdown hook is what check-points the database.
process.argv = [process.argv[0], nextBin, mode, '-H', host, '-p', port, ...process.argv.slice(3)];
await import(pathToFileURL(nextBin).href);
