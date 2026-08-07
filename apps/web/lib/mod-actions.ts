'use server';

import { and, eq } from 'drizzle-orm';
import {
  getVersionIndex,
  installMods,
  removeMods,
  resolveServer,
} from '@platter/core';
import { modInstalls } from '@platter/db';
import {
  CurseForgeClient,
  type CompatReport,
  ModRegistry,
  ModrinthClient,
  acceptedLoaders,
  resolveDependencyGraph,
} from '@platter/mods';
import { LOADER_FAMILY, isErr, logger } from '@platter/shared';
import { revalidatePath } from 'next/cache';
import { getContext } from './server';

/**
 * Mod actions for the UI.
 *
 * These mirror what the MCP server exposes, and deliberately share the same core functions —
 * `installMods` and `removeMods` live in `@platter/core` precisely so that a mod installed by a
 * human and a mod installed by an AI go through identical code. Two paths would drift, and the
 * one that drifted would be the one nobody tested.
 */

const log = logger.child('web:mods');

let registryPromise: Promise<ModRegistry> | undefined;

async function registry(): Promise<ModRegistry> {
  registryPromise ??= (async () => {
    const ctx = await getContext();
    const versionIndex = await getVersionIndex(ctx.db);
    return new ModRegistry({
      providers: [
        new ModrinthClient({
          ...(ctx.env.MODRINTH_TOKEN ? { token: ctx.env.MODRINTH_TOKEN } : {}),
          logger: log,
        }),
        new CurseForgeClient({
          ...(ctx.env.CURSEFORGE_API_KEY ? { apiKey: ctx.env.CURSEFORGE_API_KEY } : {}),
          logger: log,
        }),
      ],
      versionIndex,
      logger: log,
    });
  })();
  return registryPromise;
}

export interface ModSearchHit {
  provider: string;
  projectId: string;
  slug: string | null;
  title: string;
  summary: string | null;
  author: string | null;
  iconUrl: string | null;
  downloads: number;
  serverSide: string;
  clientSide: string;
  categories: string[];
}

export interface SearchModsResult {
  ok: boolean;
  message?: string;
  hits: ModSearchHit[];
  /** Providers that were asked but could not answer. Surfaced, never swallowed. */
  degraded: { provider: string; reason: string }[];
}

export async function searchModsAction(
  serverId: string,
  query: string
): Promise<SearchModsResult> {
  const ctx = await getContext();
  const server = resolveServer(ctx.db, serverId);
  if (!server) {
    return { ok: false, message: 'Server not found.', hits: [], degraded: [] };
  }

  const family = LOADER_FAMILY[server.loader];
  if (family === 'vanilla') {
    return {
      ok: false,
      message: 'Vanilla Minecraft cannot load mods or plugins.',
      hits: [],
      degraded: [],
    };
  }

  const found = await (
    await registry()
  ).search({
    query,
    kind: family === 'plugin' ? 'plugin' : 'mod',
    loaders: acceptedLoaders({ loader: server.loader, gameVersion: server.gameVersion }),
    gameVersions: [server.gameVersion],
    serverCompatibleOnly: true,
    limit: 24,
  });

  if (isErr(found)) {
    return { ok: false, message: found.error.message, hits: [], degraded: [] };
  }

  return {
    ok: true,
    hits: found.value.hits.map((hit) => ({
      provider: hit.provider,
      projectId: hit.projectId,
      slug: hit.slug,
      title: hit.title,
      summary: hit.summary,
      author: hit.author,
      iconUrl: hit.iconUrl,
      downloads: hit.downloads,
      serverSide: hit.serverSide,
      clientSide: hit.clientSide,
      categories: hit.categories,
    })),
    degraded: found.value.degraded.map((entry) => ({
      provider: entry.provider,
      reason: entry.reason,
    })),
  };
}

export interface ModPreview {
  ok: boolean;
  message?: string;
  title?: string;
  versionLabel?: string | null;
  report?: CompatReport;
  /** Required dependencies that would be installed alongside. */
  dependencies?: { title: string; versionLabel: string | null }[];
  totalBytes?: number;
}

/**
 * What would happen if you installed this.
 *
 * Shown before the install button becomes active. Resolving an actual downloadable file here —
 * rather than trusting the search result's compatibility fields — is the difference between an
 * honest answer and the "compatible" mods that turn out not to be.
 */
export async function previewModAction(serverId: string, ref: string): Promise<ModPreview> {
  const ctx = await getContext();
  const server = resolveServer(ctx.db, serverId);
  if (!server) {
    return { ok: false, message: 'Server not found.' };
  }

  const installed = ctx.db
    .select()
    .from(modInstalls)
    .where(and(eq(modInstalls.serverId, server.id), eq(modInstalls.status, 'installed')))
    .all()
    .map((row) => ({
      provider: row.provider as 'modrinth' | 'curseforge' | 'manual',
      projectId: row.projectSlug ?? row.id,
      title: row.displayName,
    }));

  const target = { loader: server.loader, gameVersion: server.gameVersion };
  const client = await registry();
  const resolved = await client.resolveForServer(ref, target, {
    installed,
    includeIncompatible: true,
  });

  if (isErr(resolved)) {
    return { ok: false, message: resolved.error.message };
  }

  const graph = await resolveDependencyGraph({
    root: { project: resolved.value.project, version: resolved.value.version },
    server: target,
    resolver: client,
    installed,
  });

  const extras = graph.nodes.filter(
    (node) => node.project.projectId !== resolved.value.project.projectId
  );

  return {
    ok: true,
    title: resolved.value.project.title,
    versionLabel: resolved.value.version.versionNumber,
    report: resolved.value.report,
    dependencies: extras.map((node) => ({
      title: node.project.title,
      versionLabel: node.version.versionNumber,
    })),
    totalBytes: graph.nodes.reduce((sum, node) => sum + (node.version.file?.size ?? 0), 0),
  };
}

export interface ModMutationResult {
  ok: boolean;
  message: string;
}

export async function installModAction(
  serverId: string,
  ref: string
): Promise<ModMutationResult> {
  const ctx = await getContext();
  const server = resolveServer(ctx.db, serverId);
  if (!server) {
    return { ok: false, message: 'Server not found.' };
  }

  const installed = ctx.db
    .select()
    .from(modInstalls)
    .where(and(eq(modInstalls.serverId, server.id), eq(modInstalls.status, 'installed')))
    .all()
    .map((row) => ({
      provider: row.provider as 'modrinth' | 'curseforge' | 'manual',
      projectId: row.projectSlug ?? row.id,
    }));

  const target = { loader: server.loader, gameVersion: server.gameVersion };
  const client = await registry();
  const resolved = await client.resolveForServer(ref, target, { installed });
  if (isErr(resolved)) {
    return { ok: false, message: resolved.error.message };
  }

  // A blocker means the mod cannot work. The UI disables the button in that case, but the check
  // is repeated here because a disabled button is a hint, not an authorisation boundary.
  if (resolved.value.report.blockers.length > 0) {
    return {
      ok: false,
      message: resolved.value.report.blockers.map((f) => f.detail).join(' '),
    };
  }

  const graph = await resolveDependencyGraph({
    root: { project: resolved.value.project, version: resolved.value.version },
    server: target,
    resolver: client,
    installed,
  });

  if (graph.unresolved.length > 0) {
    return {
      ok: false,
      message:
        'Some required dependencies could not be found, so installing would leave the server ' +
        `missing something it needs: ${graph.unresolved.map((u) => u.reason).join('; ')}`,
    };
  }

  const outcome = await installMods(
    ctx,
    server,
    graph.nodes.map((node) => ({ project: node.project, version: node.version })),
    { actor: 'user' }
  );

  if (isErr(outcome)) {
    return { ok: false, message: outcome.error.message };
  }

  revalidatePath(`/servers/${server.id}/mods`);

  const skipped = outcome.value.skipped;
  return {
    ok: true,
    message:
      `Installed ${outcome.value.installed.length} file${outcome.value.installed.length === 1 ? '' : 's'}. ` +
      'Restart the server to load them.' +
      (skipped.length > 0 ? ` Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}` : ''),
  };
}

export async function removeModAction(
  serverId: string,
  installId: string
): Promise<ModMutationResult> {
  const ctx = await getContext();
  const server = resolveServer(ctx.db, serverId);
  if (!server) {
    return { ok: false, message: 'Server not found.' };
  }

  const row = ctx.db.select().from(modInstalls).where(eq(modInstalls.id, installId)).get();
  if (!row || row.serverId !== server.id) {
    return { ok: false, message: 'That mod is not installed on this server.' };
  }

  const removed = await removeMods(ctx, server, [row]);
  if (isErr(removed)) {
    return { ok: false, message: removed.error.message };
  }

  revalidatePath(`/servers/${server.id}/mods`);
  return {
    ok: true,
    message: `Removed ${row.displayName}. Restart the server for the change to take effect.`,
  };
}
