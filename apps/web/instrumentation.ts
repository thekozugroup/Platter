/**
 * Boot the background supervisor with the Next.js server.
 *
 * Platter needs a long-lived process doing work outside any request: reconciling container state
 * against the database, running scheduled backups, reaping idle RCON connections. Next.js's
 * `register()` hook is the one place that runs once per server process, which makes it the right
 * home for that — and it means `pnpm dev` starts everything, with no second process to remember.
 *
 * The real work lives in `lib/bootstrap` and is imported dynamically. Next compiles this file
 * for the Edge runtime as well as Node, and a static `process.on` here makes it (correctly)
 * complain about unsupported APIs even though that branch never runs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  const { bootstrap } = await import('./lib/bootstrap');
  await bootstrap();
}
