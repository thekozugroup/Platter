import { fail, ok, type Result } from '@platter/shared';
import { describe, expect, it } from 'vitest';
import { makeProject, makeVersion } from './__fixtures__/helpers';
import {
  type DependencyResolution,
  type DependencyResolver,
  resolveDependencyGraph,
  type TargetServer,
} from './compat';
import type { DependencyRef, ModVersion } from './types';

/**
 * Dependency graph walking.
 *
 * The three properties under test here are the ones the real Modrinth graph will break if they
 * are wrong: cycles exist (usually through an API shim depending on its own implementation),
 * Fabric API is required by nearly every mod so dedupe is load-bearing, and a fifty-mod pack can
 * fan out further than anyone expects.
 */

const server: TargetServer = { loader: 'fabric', gameVersion: '1.21.1' };

const need = (projectId: string): DependencyRef => ({
  provider: 'modrinth',
  projectId,
  versionId: null,
  fileName: null,
  kind: 'required',
});

const optional = (projectId: string): DependencyRef => ({ ...need(projectId), kind: 'optional' });

/** A tiny in-memory provider: project id → the required ids of its single version. */
function graphResolver(edges: Record<string, DependencyRef[]>): DependencyResolver & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async resolve(ref: DependencyRef): Promise<Result<DependencyResolution>> {
      const id = ref.projectId ?? '';
      calls.push(id);
      const deps = edges[id];
      if (!deps) {
        return fail('not_found', `no such project ${id}`);
      }
      return ok({
        project: makeProject({ id: `modrinth:${id}`, projectId: id, slug: id, title: id }),
        version: makeVersion({ projectId: id, versionId: `${id}-v1`, dependencies: deps }),
      });
    },
  };
}

const root = (deps: DependencyRef[]): DependencyResolution => ({
  project: makeProject({ id: 'modrinth:root', projectId: 'root', slug: 'root', title: 'root' }),
  version: makeVersion({ projectId: 'root', versionId: 'root-v1', dependencies: deps }),
});

const planIds = (nodes: { project: { projectId: string } }[]): string[] =>
  nodes.map((node) => node.project.projectId);

describe('resolveDependencyGraph', () => {
  it('flattens a chain breadth-first with the root first', async () => {
    const resolver = graphResolver({ a: [need('b')], b: [need('c')], c: [] });
    const plan = await resolveDependencyGraph({ root: root([need('a')]), server, resolver });

    expect(planIds(plan.nodes)).toEqual(['root', 'a', 'b', 'c']);
    expect(plan.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 3]);
    expect(plan.nodes.map((n) => n.requiredBy)).toEqual([
      null,
      'modrinth:root',
      'modrinth:a',
      'modrinth:b',
    ]);
    expect(plan.truncated).toBe(false);
    expect(plan.unresolved).toEqual([]);
  });

  it('terminates on a cycle instead of recursing forever', async () => {
    const resolver = graphResolver({ a: [need('b')], b: [need('a'), need('root')] });
    const plan = await resolveDependencyGraph({ root: root([need('a')]), server, resolver });

    expect(planIds(plan.nodes)).toEqual(['root', 'a', 'b']);
    // `a` and `root` were both already visited when `b` pointed back at them.
    expect(resolver.calls).toEqual(['a', 'b']);
    expect(plan.truncated).toBe(false);
  });

  it('handles a self-referencing project', async () => {
    const resolver = graphResolver({ a: [need('a')] });
    const plan = await resolveDependencyGraph({ root: root([need('a')]), server, resolver });
    expect(planIds(plan.nodes)).toEqual(['root', 'a']);
  });

  it('fetches a shared dependency once, however many mods require it', async () => {
    // Fabric API, essentially. Five mods, one copy in the plan, one resolve call.
    const resolver = graphResolver({
      a: [need('fabric-api')],
      b: [need('fabric-api')],
      c: [need('fabric-api')],
      'fabric-api': [],
    });
    const plan = await resolveDependencyGraph({
      root: root([need('a'), need('b'), need('c')]),
      server,
      resolver,
    });

    expect(planIds(plan.nodes)).toEqual(['root', 'a', 'b', 'c', 'fabric-api']);
    expect(resolver.calls.filter((id) => id === 'fabric-api')).toHaveLength(1);
  });

  it('stops at the depth cap and says it did', async () => {
    const resolver = graphResolver({ a: [need('b')], b: [need('c')], c: [need('d')], d: [] });
    const plan = await resolveDependencyGraph({
      root: root([need('a')]),
      server,
      resolver,
      maxDepth: 2,
    });

    expect(planIds(plan.nodes)).toEqual(['root', 'a', 'b']);
    expect(plan.truncated).toBe(true);
  });

  it('does not claim truncation when the graph simply ends at the cap', async () => {
    const resolver = graphResolver({ a: [need('b')], b: [] });
    const plan = await resolveDependencyGraph({
      root: root([need('a')]),
      server,
      resolver,
      maxDepth: 2,
    });

    expect(planIds(plan.nodes)).toEqual(['root', 'a', 'b']);
    expect(plan.truncated).toBe(false);
  });

  it('stops at the node cap', async () => {
    const resolver = graphResolver({ a: [], b: [], c: [], d: [] });
    const plan = await resolveDependencyGraph({
      root: root([need('a'), need('b'), need('c'), need('d')]),
      server,
      resolver,
      maxNodes: 3,
    });

    expect(plan.nodes).toHaveLength(3);
    expect(plan.truncated).toBe(true);
  });

  it('collects unresolvable refs without discarding what did resolve', async () => {
    const resolver = graphResolver({ a: [], c: [] });
    const plan = await resolveDependencyGraph({
      root: root([need('a'), need('missing'), need('c')]),
      server,
      resolver,
    });

    expect(planIds(plan.nodes)).toEqual(['root', 'a', 'c']);
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.unresolved[0]?.ref.projectId).toBe('missing');
    expect(plan.unresolved[0]?.requiredBy).toBe('modrinth:root');
    expect(plan.unresolved[0]?.reason).toContain('no such project');
  });

  it('reports a filename-only dependency as unresolvable without calling the resolver', async () => {
    const resolver = graphResolver({});
    const plan = await resolveDependencyGraph({
      root: root([
        {
          provider: 'modrinth',
          projectId: null,
          versionId: null,
          fileName: 'vendored-lib.jar',
          kind: 'required',
        },
      ]),
      server,
      resolver,
    });

    expect(resolver.calls).toEqual([]);
    expect(plan.unresolved[0]?.reason).toContain('vendored-lib.jar');
    expect(plan.unresolved[0]?.reason).toContain('cannot be fetched automatically');
  });

  it('does not re-resolve a dependency that failed on another path', async () => {
    const resolver = graphResolver({ a: [need('missing')], b: [need('missing')] });
    const plan = await resolveDependencyGraph({
      root: root([need('a'), need('b')]),
      server,
      resolver,
    });

    expect(resolver.calls.filter((id) => id === 'missing')).toHaveLength(1);
    expect(plan.unresolved).toHaveLength(1);
  });

  it('skips dependencies already installed on the server', async () => {
    const resolver = graphResolver({ a: [need('fabric-api')], 'fabric-api': [] });
    const plan = await resolveDependencyGraph({
      root: root([need('a')]),
      server,
      resolver,
      installed: [{ provider: 'modrinth', projectId: 'fabric-api', title: 'Fabric API' }],
    });

    expect(planIds(plan.nodes)).toEqual(['root', 'a']);
    expect(resolver.calls).not.toContain('fabric-api');
  });

  it('walks only required edges', async () => {
    const resolver = graphResolver({ a: [], b: [], c: [] });
    const plan = await resolveDependencyGraph({
      root: root([need('a'), optional('b'), { ...need('c'), kind: 'incompatible' }]),
      server,
      resolver,
    });

    expect(planIds(plan.nodes)).toEqual(['root', 'a']);
    expect(resolver.calls).toEqual(['a']);
  });

  it('honours a version-pinned ref by passing it through untouched', async () => {
    const seen: DependencyRef[] = [];
    const resolver: DependencyResolver = {
      async resolve(ref): Promise<Result<DependencyResolution>> {
        seen.push(ref);
        const version: ModVersion = makeVersion({ versionId: ref.versionId ?? 'x' });
        return ok({ project: makeProject({ projectId: 'pinned' }), version });
      },
    };
    await resolveDependencyGraph({
      root: root([{ ...need('pinned'), versionId: 's7adptIg' }]),
      server,
      resolver,
    });

    expect(seen[0]?.versionId).toBe('s7adptIg');
  });
});
