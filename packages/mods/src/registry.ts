import {
  LOADER_ACCEPTS,
  LOADER_LABELS,
  type Logger,
  type ModProvider,
  type Result,
  type VersionIndex,
  fail,
  logger as rootLogger,
  ok,
} from '@platter/shared';
import {
  type CompatReport,
  type DependencyResolution,
  type DependencyResolver,
  type InstalledMod,
  NEOFORGE_FORGE_BRIDGE_VERSION,
  type TargetServer,
  type Verdict,
  checkCompatibility,
} from './compat';
import {
  type DependencyRef,
  type ModProject,
  type ModSearchQuery,
  type ModSearchResult,
  type ModVersion,
  type ProviderAvailability,
  type ProviderClient,
  modSearchQuerySchema,
  parseQualifiedId,
} from './types';

/**
 * The one thing the rest of Platter talks to.
 *
 * Everything above this line is provider-shaped; everything below it is Platter-shaped. The
 * registry's job is to make "find me a mod that works on this server" a single call, which means
 * three things nobody else should have to think about:
 *
 *   - **Fan-out and degradation.** CurseForge is off for most installs because its key needs
 *     human approval. A search must return Modrinth's results rather than an error, and it must
 *     say which provider it could not reach instead of pretending the catalogue is complete.
 *   - **Cross-posting.** Most large mods are published to both platforms. Showing the same mod
 *     twice, from two ids, with two "Install" buttons, is how someone ends up with two copies of
 *     the same jar in mods/.
 *   - **Candidates are not answers.** Both search APIs return projects whose *historical* loader
 *     and version union overlaps the query. `resolveForServer` is where a project becomes a
 *     specific file with a verdict attached.
 */

export interface ModRegistryOptions {
  /** In preference order — the first provider to publish a project wins a cross-post dedupe. */
  providers: readonly ProviderClient[];
  /** Shared by every compatibility check. Build it from `ModrinthClient#getVersionIndex()`. */
  versionIndex?: VersionIndex;
  logger?: Logger;
}

export interface ResolveOptions {
  installed?: readonly InstalledMod[];
  /**
   * Include versions that failed the check. The default returns the best *usable* version and
   * an error when there is none; turning this on returns the best candidate plus the report
   * explaining why it will not work, which is what the UI wants for "why can't I install this?".
   */
  includeIncompatible?: boolean;
}

export interface ResolvedForServer extends DependencyResolution {
  report: CompatReport;
  /** Every version considered, best first. Lets a UI offer "use an older build instead". */
  alternatives: { version: ModVersion; report: CompatReport }[];
}

const VERDICT_RANK: Readonly<Record<Verdict, number>> = {
  compatible: 0,
  compatible_with_warnings: 1,
  unknown: 2,
  incompatible: 3,
};

export class ModRegistry implements DependencyResolver {
  private readonly providers: readonly ProviderClient[];
  private readonly versionIndex: VersionIndex | undefined;
  private readonly log: Logger;

  constructor(options: ModRegistryOptions) {
    this.providers = options.providers;
    this.versionIndex = options.versionIndex;
    this.log = options.logger ?? rootLogger.child('mods:registry');
  }

  /** Only providers that can actually answer. A missing CurseForge key drops it from here. */
  enabled(): ProviderClient[] {
    return this.providers.filter((provider) => provider.availability().available);
  }

  availability(): { provider: ModProvider; status: ProviderAvailability }[] {
    return this.providers.map((provider) => ({
      provider: provider.provider,
      status: provider.availability(),
    }));
  }

  private clientFor(provider: ModProvider): ProviderClient | undefined {
    return this.providers.find((client) => client.provider === provider);
  }

  /* --- Search ------------------------------------------------------------ */

  /**
   * Search every enabled provider and merge.
   *
   * A provider that fails is recorded in `degraded` rather than failing the whole call — a
   * CurseForge 429 should not take Modrinth's results down with it. The call only fails when
   * *nothing* answered, because at that point there is genuinely nothing to show.
   */
  async search(query: ModSearchQuery): Promise<Result<ModSearchResult>> {
    const parsed = modSearchQuerySchema.safeParse(query);
    if (!parsed.success) {
      return fail('invalid_input', 'Invalid mod search query', {
        details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      });
    }
    const resolved = parsed.data;

    const wanted = new Set(resolved.providers);
    const targets = this.enabled().filter(
      (provider) => wanted.size === 0 || wanted.has(provider.provider)
    );
    if (targets.length === 0) {
      return fail('not_supported', 'No mod provider is enabled', {
        details: { availability: this.availability() },
      });
    }

    const settled = await Promise.all(
      targets.map(async (client) => ({ client, result: await client.search(resolved) }))
    );

    const answered: { provider: ModProvider; hits: ModProject[]; totalHits: number }[] = [];
    const degraded: { provider: ModProvider; reason: string }[] = [];
    for (const { client, result } of settled) {
      if (result.ok) {
        answered.push({
          provider: client.provider,
          hits: result.value.hits,
          totalHits: result.value.totalHits,
        });
      } else {
        this.log.warn('provider search failed', {
          provider: client.provider,
          reason: result.error.message,
        });
        degraded.push({ provider: client.provider, reason: result.error.message });
      }
    }

    if (answered.length === 0) {
      return fail('upstream_error', 'Every mod provider failed', { details: { degraded } });
    }

    const merged = this.dedupe(answered.map((entry) => entry.hits), resolved.sort);
    return ok({
      hits: merged.slice(0, resolved.limit),
      offset: resolved.offset,
      limit: resolved.limit,
      // Summed, so "about this many" stays roughly honest. Both providers over- and
      // under-report in their own ways and cross-posts are double-counted here; the number is
      // only ever used for "is there more".
      totalHits: answered.reduce((total, entry) => total + entry.totalHits, 0),
      providers: answered.map((entry) => entry.provider),
      degraded,
    });
  }

  /**
   * Merge per-provider hit lists, dropping obvious cross-posts.
   *
   * Interleaved round-robin rather than concatenated, because each provider's ordering already
   * encodes its own relevance ranking and there is no comparable score across the two. Taking
   * one from each in turn preserves both rankings; sorting by downloads would hand the list to
   * whichever platform is bigger regardless of what was asked for.
   */
  private dedupe(lists: readonly ModProject[][], sort: string): ModProject[] {
    const seen = new Set<string>();
    const out: ModProject[] = [];

    const push = (project: ModProject): void => {
      // Slug is the strong signal — cross-posted projects almost always keep it. Title is the
      // fallback and is normalised hard, because "JEI" and "Just Enough Items" are the same mod
      // and "Sodium" and "sodium " are trivially so.
      const keys = [
        project.slug ? `slug:${project.slug.toLowerCase()}` : undefined,
        `title:${project.title.trim().toLowerCase().replace(/\s+/g, ' ')}`,
      ].filter((key): key is string => key !== undefined);
      if (keys.some((key) => seen.has(key))) {
        return;
      }
      for (const key of keys) {
        seen.add(key);
      }
      out.push(project);
    };

    const longest = Math.max(0, ...lists.map((list) => list.length));
    for (let rank = 0; rank < longest; rank++) {
      for (const list of lists) {
        const project = list[rank];
        if (project) {
          push(project);
        }
      }
    }

    // Numeric sorts are comparable across providers, so honour them after the merge.
    if (sort === 'downloads') {
      out.sort((a, b) => b.downloads - a.downloads);
    } else if (sort === 'follows') {
      out.sort((a, b) => b.followers - a.followers);
    }
    return out;
  }

  /* --- Projects ---------------------------------------------------------- */

  /**
   * `modrinth:AANobbMI`, `curseforge:238222`, or a bare slug.
   *
   * A bare slug is tried against each provider in preference order. That is one wasted request
   * when the mod is only on the second one, and it is worth it — users paste slugs from URLs and
   * making them work out which platform a mod came from is a bad first interaction.
   */
  async getProject(ref: string): Promise<Result<ModProject>> {
    const qualified = parseQualifiedId(ref);
    if (qualified) {
      const client = this.clientFor(qualified.provider);
      if (!client) {
        return fail('not_supported', `Provider "${qualified.provider}" is not configured`);
      }
      return client.getProject(qualified.id);
    }

    const errors: string[] = [];
    for (const client of this.enabled()) {
      const result = await client.getProject(ref);
      if (result.ok) {
        return result;
      }
      errors.push(`${client.provider}: ${result.error.message}`);
    }
    return fail('not_found', `No provider has a project called "${ref}"`, {
      details: { ref, errors },
    });
  }

  /* --- Resolution -------------------------------------------------------- */

  /**
   * Turn a project reference into the best version for this server, with its verdict.
   *
   * Two-pass on purpose. The first pass asks the provider to filter by loader and game version,
   * which is cheap and usually right. If that returns nothing, the second pass fetches
   * unfiltered — because "no compatible version" and "no versions at all" are different answers,
   * and the user deserves the one that says *which* Minecraft versions this mod does support.
   */
  async resolveForServer(
    ref: string,
    server: TargetServer,
    options: ResolveOptions = {}
  ): Promise<Result<ResolvedForServer>> {
    const project = await this.getProject(ref);
    if (!project.ok) {
      return project;
    }
    return this.resolveProject(project.value, server, options);
  }

  async resolveProject(
    project: ModProject,
    server: TargetServer,
    options: ResolveOptions = {}
  ): Promise<Result<ResolvedForServer>> {
    const client = this.clientFor(project.provider);
    if (!client) {
      return fail('not_supported', `Provider "${project.provider}" is not configured`);
    }

    const loaders = acceptedLoaders(server);
    const filtered = await client.getVersions(project.projectId, {
      loaders,
      gameVersions: [server.gameVersion],
    });
    if (!filtered.ok) {
      return filtered;
    }

    let candidates = filtered.value;
    if (candidates.length === 0) {
      const all = await client.getVersions(project.projectId, { limit: 40 });
      if (!all.ok) {
        return all;
      }
      candidates = all.value;
    }

    if (candidates.length === 0) {
      return fail('not_found', `${project.title} has no published versions`, {
        details: { project: project.id },
      });
    }

    const graded = candidates
      .map((version) => ({
        version,
        report: checkCompatibility({
          server,
          project,
          version,
          installed: options.installed,
          versionIndex: this.versionIndex,
        }),
      }))
      .sort(compareGraded);

    const best = graded[0];
    if (!best) {
      return fail('not_found', `${project.title} has no usable versions`);
    }

    if (best.report.verdict === 'incompatible' && options.includeIncompatible !== true) {
      const reason = best.report.blockers[0]?.detail ?? 'No compatible build was found.';
      return fail(
        'not_found',
        `No build of ${project.title} works on ${LOADER_LABELS[server.loader]} ${server.gameVersion}. ${reason}`,
        {
          details: {
            project: project.id,
            considered: graded.length,
            blockers: best.report.blockers.map((finding) => finding.code),
          },
        }
      );
    }

    return ok({
      project,
      version: best.version,
      report: best.report,
      alternatives: graded.slice(1, 10),
    });
  }

  /**
   * `DependencyResolver`, so `resolveDependencyGraph` can walk the graph through the registry.
   *
   * A ref that pins an exact version id is honoured verbatim — the author said *that* build, and
   * substituting a different one would be second-guessing a constraint we cannot see the reason
   * for. A project-level ref (all CurseForge refs, and most Modrinth ones) goes through the same
   * resolution as a user-initiated install, so a dependency gets the same compatibility scrutiny
   * as anything else that lands in mods/.
   */
  async resolve(ref: DependencyRef, server: TargetServer): Promise<Result<DependencyResolution>> {
    const client = this.clientFor(ref.provider);
    if (!client) {
      return fail('not_supported', `Provider "${ref.provider}" is not configured`);
    }

    if (ref.versionId) {
      const version = await client.getVersion(ref.versionId);
      if (!version.ok) {
        return version;
      }
      const project = await client.getProject(version.value.projectId);
      return project.ok ? ok({ project: project.value, version: version.value }) : project;
    }

    if (!ref.projectId) {
      return fail('not_found', 'Dependency has neither a project nor a version to resolve');
    }

    const resolved = await this.resolveForServer(`${ref.provider}:${ref.projectId}`, server);
    return resolved.ok ? ok({ project: resolved.value.project, version: resolved.value.version }) : resolved;
  }
}

/**
 * Loader names to ask a provider for.
 *
 * `LOADER_ACCEPTS` covers the static inheritance (Quilt loads Fabric, Purpur loads Paper and
 * Spigot). The 1.20.1 NeoForge/Forge bridge is version-dependent so it cannot live in that
 * table, and it is added here — without it, a NeoForge 1.20.1 server would never even *fetch*
 * the Forge builds that `compat.ts` would then happily approve.
 */
export function acceptedLoaders(server: TargetServer): string[] {
  const accepted = [...LOADER_ACCEPTS[server.loader]];
  if (server.loader === 'neoforge' && server.gameVersion === NEOFORGE_FORGE_BRIDGE_VERSION) {
    accepted.push('forge');
  }
  if (server.loader === 'forge' && server.gameVersion === NEOFORGE_FORGE_BRIDGE_VERSION) {
    accepted.push('neoforge');
  }
  return accepted;
}

/** Best first: usable beats unusable, then score, then newest. */
function compareGraded(
  a: { version: ModVersion; report: CompatReport },
  b: { version: ModVersion; report: CompatReport }
): number {
  const verdict = VERDICT_RANK[a.report.verdict] - VERDICT_RANK[b.report.verdict];
  if (verdict !== 0) {
    return verdict;
  }
  if (a.report.score !== b.report.score) {
    return b.report.score - a.report.score;
  }
  // Publish dates are ISO 8601 from both providers, so lexicographic ordering is chronological.
  return (b.version.publishedAt ?? '').localeCompare(a.version.publishedAt ?? '');
}
