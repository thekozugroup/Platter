import { type Context, getVersionIndex } from '@platter/core';
import { CurseForgeClient, ModRegistry, ModrinthClient } from '@platter/mods';
import { logger } from '@platter/shared';

/**
 * The mod registry, built once per process.
 *
 * Construction is memoised because the registry holds the HTTP layer's rate-limit buckets and
 * response cache. Rebuilding it per tool call would reset both, and Modrinth's 300/min budget
 * disappears fast when an agent resolves a twenty-mod dependency graph.
 *
 * The version index comes from Platter's own cache rather than a fresh fetch, so the first
 * compatibility check does not pay for a tag download — and still works offline.
 */
let cached: Promise<ModRegistry> | undefined;

export function getRegistry(ctx: Context): Promise<ModRegistry> {
  cached ??= build(ctx);
  return cached;
}

async function build(ctx: Context): Promise<ModRegistry> {
  const versionIndex = await getVersionIndex(ctx.db);
  const log = logger.child('mcp:mods');

  const modrinth = new ModrinthClient({
    ...(ctx.env.MODRINTH_TOKEN ? { token: ctx.env.MODRINTH_TOKEN } : {}),
    logger: log,
  });

  // CurseForge needs a key that requires human approval to obtain, so most installs will not
  // have one. The client reports itself unavailable rather than throwing, and the registry
  // degrades to Modrinth-only — which is the right behaviour, not an error to surface.
  const curseforge = new CurseForgeClient({
    ...(ctx.env.CURSEFORGE_API_KEY ? { apiKey: ctx.env.CURSEFORGE_API_KEY } : {}),
    logger: log,
  });

  return new ModRegistry({
    // Modrinth first: it has real client/server side metadata, which the compatibility engine
    // depends on, so it wins cross-post dedupes.
    providers: [modrinth, curseforge],
    versionIndex,
    logger: log,
  });
}

/** Test seam. */
export function resetRegistry(): void {
  cached = undefined;
}
