import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { type Context, contentDirectory, getVersionIndex, resolveServer } from '@platter/core';
import { modInstalls } from '@platter/db';
import { LOADER_FAMILY, LOADER_LABELS, isErr } from '@platter/shared';
import { z } from 'zod';
import { proposeAndConfirm, recordOutcome } from '../confirm';
import { formatBytes, result, toolError } from '../format';
import { acceptedLoaders, resolveDependencyGraph } from '@platter/mods';
import { getRegistry } from '../registry';
import { installMods, removeMods } from '../install';

/**
 * Mod curation.
 *
 * The workflow this is designed around, and the reason the tools are split this way:
 *
 *   search_mods         cast a wide net, get candidates with descriptions
 *   check_mod           for a specific candidate, get a verdict against *this* server
 *   install_mods        propose, let the human confirm, then install with dependencies
 *
 * The separation matters because `search_mods` results are only candidates. Modrinth's
 * project-level `game_versions` and `loaders` fields are the union across every version ever
 * published, so a project that lists both Fabric and 1.21.4 may have no single file supporting
 * both. `check_mod` resolves an actual file and is the only thing that can answer "will this
 * work". Skipping it is the single biggest source of false-positive compatibility.
 */
export function registerModTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'search_mods',
    {
      title: 'Search for mods and plugins',
      description:
        'Search Modrinth (and CurseForge when an API key is configured) for mods, plugins, ' +
        'datapacks and shaders. Results are CANDIDATES — the compatibility fields on a search ' +
        'result describe everything the project has ever supported, not one downloadable file. ' +
        'Always follow up with check_mod before proposing an install.',
      inputSchema: {
        query: z.string().describe('What to search for, e.g. "chunk loading performance"'),
        server: z
          .string()
          .optional()
          .describe('Server id/slug/name — filters results to what could run on it'),
        kind: z
          .enum(['mod', 'plugin', 'datapack', 'resourcepack', 'shader', 'modpack'])
          .optional()
          .describe('Narrow by content type'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, server: reference, kind, limit }) => {
      const target = reference ? resolveServer(ctx.db, reference) : undefined;
      if (reference && !target) {
        return toolError(`No server matching "${reference}".`);
      }

      const registry = await getRegistry(ctx);
      const found = await registry.search({
        query,
        limit,
        kind: kind ?? (target && LOADER_FAMILY[target.loader] === 'plugin' ? 'plugin' : 'mod'),
        // Filtering by the server's loader and version narrows the candidate set upstream,
        // which matters because the alternative is paging through results that could never run.
        ...(target
          ? {
              loaders: acceptedLoaders({ loader: target.loader, gameVersion: target.gameVersion }),
              gameVersions: [target.gameVersion],
              serverCompatibleOnly: true,
            }
          : {}),
      });

      if (isErr(found)) {
        return toolError(found.error.message, 'Modrinth may be rate-limiting or unreachable.');
      }

      const hits = found.value.hits;
      const degraded = found.value.degraded;
      const text =
        hits.length === 0
          ? `Nothing found for "${query}".` +
            (target ? ` Try dropping the server filter — ${LOADER_LABELS[target.loader]} ${target.gameVersion} may be narrow.` : '')
          : hits
              .map(
                (hit) =>
                  `• ${hit.title} (${hit.provider}:${hit.slug ?? hit.projectId})\n` +
                  `  ${hit.summary ?? 'No description.'}\n` +
                  `  ${hit.downloads?.toLocaleString() ?? '?'} downloads · server-side: ${hit.serverSide} · client-side: ${hit.clientSide}`
              )
              .join('\n\n');

      return result(
        degraded.length > 0
          ? `${text}\n\n(Could not reach: ${degraded.map((d) => `${d.provider} — ${d.reason}`).join('; ')})`
          : text,
        {
        query,
        providers: found.value.providers,
        degraded,
        results: hits.map((hit) => ({
          provider: hit.provider,
          projectId: hit.projectId,
          slug: hit.slug,
          title: hit.title,
          summary: hit.summary,
          downloads: hit.downloads,
          clientSide: hit.clientSide,
          serverSide: hit.serverSide,
          categories: hit.categories,
          loaders: hit.loaders,
          projectUrl: hit.projectUrl,
        })),
      }
      );
    }
  );

  server.registerTool(
    'check_mod',
    {
      title: 'Check whether a mod works on a server',
      description:
        "Resolve a mod to the best matching file for a server's loader and Minecraft version, " +
        'and return a compatibility verdict: blockers, warnings, missing dependencies and ' +
        'conflicts with what is already installed. This is the authoritative answer — call it ' +
        'before proposing any install.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        mod: z.string().describe('Mod slug or id, e.g. "lithium" or "modrinth:lithium"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ server: reference, mod }) => {
      const target = resolveServer(ctx.db, reference);
      if (!target) {
        return toolError(`No server matching "${reference}".`);
      }
      if (LOADER_FAMILY[target.loader] === 'vanilla') {
        return toolError(
          `${target.name} runs vanilla Minecraft, which cannot load mods or plugins.`,
          'Recreate it as Paper (for plugins) or Fabric/NeoForge (for mods) to add content.'
        );
      }

      const registry = await getRegistry(ctx);
      const index = await getVersionIndex(ctx.db);
      const resolved = await registry.resolveForServer(
        mod,
        { loader: target.loader, gameVersion: target.gameVersion },
        // `includeIncompatible` so "why can't I install this?" gets a real answer instead of a
        // bare "no compatible version", which is the least useful thing to tell someone.
        { installed: installedFor(ctx, target.id), includeIncompatible: true }
      );

      if (isErr(resolved)) {
        return toolError(resolved.error.message);
      }

      const { project, version, report } = resolved.value;
      const lines = [
        `${project.title} ${version?.versionNumber ?? ''} on ${target.name} — ${report.verdict} (${report.score}/100)`,
      ];
      if (report.blockers.length > 0) {
        lines.push('', 'Blockers:', ...report.blockers.map((f) => `  ✗ ${f.title} — ${f.detail}`));
      }
      if (report.warnings.length > 0) {
        lines.push('', 'Warnings:', ...report.warnings.map((f) => `  ! ${f.title} — ${f.detail}`));
      }
      if (report.missingDependencies.length > 0) {
        lines.push(
          '',
          'Needs these too:',
          ...report.missingDependencies.map((d) => `  + ${d.projectId} (${d.provider})`)
        );
      }
      if (report.notes.length > 0) {
        lines.push('', ...report.notes.map((f) => `  · ${f.detail}`));
      }

      return result(lines.join('\n'), {
        project: {
          provider: project.provider,
          projectId: project.projectId,
          slug: project.slug,
          title: project.title,
          serverSide: project.serverSide,
          clientSide: project.clientSide,
        },
        version: version
          ? {
              versionId: version.versionId,
              versionNumber: version.versionNumber,
              channel: version.channel,
              gameVersions: version.gameVersions,
              loaders: version.loaders,
              downloadable: version.downloadable,
              fileName: version.file?.name ?? null,
              fileSize: version.file?.size ?? null,
            }
          : null,
        report,
      });
    }
  );

  server.registerTool(
    'list_installed_mods',
    {
      title: 'List installed mods',
      description:
        'What is installed on a server, including which entries Platter added automatically to ' +
        'satisfy a dependency.',
      inputSchema: { server: z.string().describe('Server id, slug or name') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ server: reference }) => {
      const target = resolveServer(ctx.db, reference);
      if (!target) {
        return toolError(`No server matching "${reference}".`);
      }

      const rows = ctx.db
        .select()
        .from(modInstalls)
        .where(and(eq(modInstalls.serverId, target.id), eq(modInstalls.status, 'installed')))
        .all();

      const text =
        rows.length === 0
          ? `Nothing installed on ${target.name}.`
          : rows
              .map(
                (row) =>
                  `• ${row.displayName} ${row.versionLabel ?? ''} (${row.provider}:${row.projectSlug ?? '?'})` +
                  `${row.isDependency ? ' — dependency' : ''}` +
                  `${row.installedBy === 'ai' ? ' — added by AI' : ''}`
              )
              .join('\n');

      return result(text, {
        server: target.id,
        directory: contentDirectory(target.loader),
        mods: rows.map((row) => ({
          id: row.id,
          name: row.displayName,
          provider: row.provider,
          slug: row.projectSlug,
          version: row.versionLabel,
          filePath: row.filePath,
          isDependency: row.isDependency,
          installedBy: row.installedBy,
        })),
      });
    }
  );

  server.registerTool(
    'install_mods',
    {
      title: 'Install mods',
      description:
        'Install one or more mods, pulling in required dependencies automatically. Every ' +
        'candidate is compatibility-checked first, the human sees exactly what will be added ' +
        'and any warnings, and nothing is downloaded until they approve. A backup is taken ' +
        'first. The server must be restarted afterwards for mods to load.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        mods: z.array(z.string()).min(1).max(20).describe('Mod slugs or ids'),
        reason: z.string().optional().describe('Why these — shown to the human deciding'),
        allowWarnings: z
          .boolean()
          .default(false)
          .describe('Proceed when the check returns warnings (never blockers)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ server: reference, mods, reason, allowWarnings }) => {
      const target = resolveServer(ctx.db, reference);
      if (!target) {
        return toolError(`No server matching "${reference}".`);
      }
      if (LOADER_FAMILY[target.loader] === 'vanilla') {
        return toolError(`${target.name} runs vanilla Minecraft and cannot load mods or plugins.`);
      }

      const registry = await getRegistry(ctx);
      const index = await getVersionIndex(ctx.db);
      const installed = installedFor(ctx, target.id);

      const plan: {
        title: string;
        ref: string;
        report: Awaited<ReturnType<typeof registry.resolveForServer>>;
      }[] = [];

      for (const ref of mods) {
        const resolved = await registry.resolveForServer(
          ref,
          { loader: target.loader, gameVersion: target.gameVersion },
          { installed, includeIncompatible: true }
        );
        plan.push({ title: ref, ref, report: resolved });
      }

      const failures = plan.filter((entry) => isErr(entry.report));
      if (failures.length > 0) {
        return toolError(
          `Could not resolve: ${failures.map((f) => f.ref).join(', ')}`,
          failures.map((f) => (isErr(f.report) ? f.report.error.message : '')).join('\n')
        );
      }

      const resolvedEntries = plan.map((entry) => {
        if (isErr(entry.report)) {
          throw new Error('unreachable — failures filtered above');
        }
        return entry.report.value;
      });

      const blocked = resolvedEntries.filter((entry) => entry.report.blockers.length > 0);
      if (blocked.length > 0) {
        const detail = blocked
          .map(
            (entry) =>
              `${entry.project.title}:\n` +
              entry.report.blockers.map((f) => `  ✗ ${f.title} — ${f.detail}`).join('\n')
          )
          .join('\n\n');
        return toolError(
          `${blocked.length} of these cannot work on ${target.name}.`,
          `${detail}\n\nFix or drop them and try again — Platter will not install a mod it knows will break the server.`
        );
      }

      const warned = resolvedEntries.filter((entry) => entry.report.warnings.length > 0);
      if (warned.length > 0 && !allowWarnings) {
        const detail = warned
          .map(
            (entry) =>
              `${entry.project.title}:\n` +
              entry.report.warnings.map((f) => `  ! ${f.title} — ${f.detail}`).join('\n')
          )
          .join('\n\n');
        return toolError(
          'These have warnings. Review them, then call again with allowWarnings: true if they are acceptable.',
          detail
        );
      }

      // Walk each root's required dependencies. Deduped across roots, because a five-mod
      // install where every one needs Fabric API must not queue five copies of it.
      const targetSpec = { loader: target.loader, gameVersion: target.gameVersion };
      const seen = new Set(
        resolvedEntries.map((entry) => `${entry.project.provider}:${entry.project.projectId}`)
      );
      const dependencies: { project: (typeof resolvedEntries)[number]['project']; version: (typeof resolvedEntries)[number]['version'] }[] = [];
      const unresolved: { name: string; reason: string }[] = [];

      for (const entry of resolvedEntries) {
        const graph = await resolveDependencyGraph({
          root: { project: entry.project, version: entry.version },
          server: targetSpec,
          resolver: registry,
          installed,
        });
        for (const node of graph.nodes) {
          const key = `${node.project.provider}:${node.project.projectId}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          dependencies.push({ project: node.project, version: node.version });
        }
        for (const missing of graph.unresolved) {
          unresolved.push({ name: missing.ref.projectId ?? 'unknown', reason: missing.reason });
        }
      }

      if (unresolved.length > 0) {
        return toolError(
          'Some required dependencies could not be resolved, so installing would leave the ' +
            'server missing something it needs.',
          unresolved.map((u) => `• ${u.name}: ${u.reason}`).join('\n')
        );
      }

      const totalBytes = [...resolvedEntries, ...dependencies].reduce(
        (sum, entry) => sum + (entry.version?.file?.size ?? 0),
        0
      );

      const details = [
        ...resolvedEntries.map(
          (entry) => `• ${entry.project.title} ${entry.version?.versionNumber ?? ''}`
        ),
        ...(dependencies.length > 0
          ? [
              '',
              'Plus these required dependencies:',
              ...dependencies.map((d) => `• ${d.project.title} ${d.version?.versionNumber ?? ''}`),
            ]
          : []),
        '',
        `Total download: ${formatBytes(totalBytes)}.`,
        `Files go in /data/${contentDirectory(target.loader)}.`,
        'Platter backs the server up first, and the server needs a restart to load them.',
        ...(warned.length > 0 ? ['', 'Warnings were reviewed and accepted.'] : []),
      ];

      const decision = await proposeAndConfirm({
        ctx,
        server,
        serverId: target.id,
        kind: 'install_mods',
        title: `Install ${resolvedEntries.length} mod${resolvedEntries.length === 1 ? '' : 's'} on ${target.name}`,
        rationale: reason,
        payload: {
          mods: resolvedEntries.map((entry) => ({
            provider: entry.project.provider,
            projectId: entry.project.projectId,
            title: entry.project.title,
            versionId: entry.version?.versionId,
          })),
          dependencies: dependencies.map((d) => ({
            provider: d.project.provider,
            projectId: d.project.projectId,
            title: d.project.title,
          })),
        },
        compatReport: resolvedEntries.map((entry) => entry.report),
        impact: { requiresRestart: true, downloadBytes: totalBytes },
        question: `Install ${resolvedEntries.map((e) => e.project.title).join(', ')} on ${target.name}?`,
        details,
      });

      if (!decision.approved) {
        return result(decision.message, { installed: false, reason: decision.reason });
      }

      const outcome = await installMods(ctx, target, [...resolvedEntries, ...dependencies], {
        proposalId: decision.proposalId,
      });

      recordOutcome(ctx, decision.proposalId, {
        ok: !isErr(outcome),
        serverId: target.id,
        ...(isErr(outcome) ? { message: outcome.error.message } : { result: outcome.value }),
      });

      if (isErr(outcome)) {
        return toolError(outcome.error.message);
      }

      return result(
        `Installed ${outcome.value.installed.length} file${outcome.value.installed.length === 1 ? '' : 's'} ` +
          `on ${target.name}. Restart it to load them — use control_server with action "restart".`,
        outcome.value
      );
    }
  );

  server.registerTool(
    'remove_mods',
    {
      title: 'Remove mods',
      description:
        'Remove installed mods. Warns when something else depends on what you are removing. ' +
        'Asks for confirmation, backs up first, and requires a restart to take effect.',
      inputSchema: {
        server: z.string().describe('Server id, slug or name'),
        mods: z.array(z.string()).min(1).max(50).describe('Mod slugs, ids or install ids'),
        reason: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ server: reference, mods, reason }) => {
      const target = resolveServer(ctx.db, reference);
      if (!target) {
        return toolError(`No server matching "${reference}".`);
      }

      const rows = ctx.db
        .select()
        .from(modInstalls)
        .where(and(eq(modInstalls.serverId, target.id), eq(modInstalls.status, 'installed')))
        .all();

      const wanted = new Set(mods.map((m) => m.toLowerCase()));
      const matched = rows.filter(
        (row) =>
          wanted.has(row.id.toLowerCase()) ||
          wanted.has((row.projectSlug ?? '').toLowerCase()) ||
          wanted.has(row.displayName.toLowerCase())
      );

      if (matched.length === 0) {
        return toolError(
          `None of those are installed on ${target.name}.`,
          'Call list_installed_mods to see what is there.'
        );
      }

      const matchedIds = new Set(matched.map((row) => row.id));
      const orphaned = rows.filter(
        (row) => !matchedIds.has(row.id) && row.requiredBy !== null && matchedIds.has(row.requiredBy)
      );
      const breaks = rows.filter(
        (row) => !matchedIds.has(row.id) && matched.some((m) => row.requiredBy === m.id)
      );

      const decision = await proposeAndConfirm({
        ctx,
        server,
        serverId: target.id,
        kind: 'remove_mods',
        title: `Remove ${matched.length} mod${matched.length === 1 ? '' : 's'} from ${target.name}`,
        rationale: reason,
        payload: { mods: matched.map((row) => ({ id: row.id, name: row.displayName })) },
        impact: { requiresRestart: true, orphans: orphaned.length },
        question: `Remove ${matched.map((row) => row.displayName).join(', ')} from ${target.name}?`,
        details: [
          ...matched.map((row) => `• ${row.displayName} ${row.versionLabel ?? ''}`),
          ...(breaks.length > 0
            ? ['', 'These depend on what you are removing and may stop working:', ...breaks.map((row) => `• ${row.displayName}`)]
            : []),
          '',
          'Platter backs the server up first. A restart is needed for the change to take effect.',
        ],
      });

      if (!decision.approved) {
        return result(decision.message, { removed: false, reason: decision.reason });
      }

      const outcome = await removeMods(ctx, target, matched);
      recordOutcome(ctx, decision.proposalId, {
        ok: !isErr(outcome),
        serverId: target.id,
        ...(isErr(outcome) ? { message: outcome.error.message } : { result: outcome.value }),
      });

      if (isErr(outcome)) {
        return toolError(outcome.error.message);
      }
      return result(
        `Removed ${outcome.value.removed.length} file${outcome.value.removed.length === 1 ? '' : 's'}. ` +
          'Restart the server for the change to take effect.',
        outcome.value
      );
    }
  );
}

function installedFor(ctx: Context, serverId: string) {
  return ctx.db
    .select()
    .from(modInstalls)
    .where(and(eq(modInstalls.serverId, serverId), eq(modInstalls.status, 'installed')))
    .all()
    .map((row) => ({
      provider: row.provider as 'modrinth' | 'curseforge' | 'manual',
      projectId: row.projectSlug ?? row.id,
      name: row.displayName,
      versionId: row.modVersionId ?? undefined,
    }));
}
