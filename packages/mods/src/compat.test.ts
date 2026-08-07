import { describe, expect, it } from 'vitest';
import { gameVersionIndex, makeProject, makeVersion } from './__fixtures__/helpers';
import {
  type CompatReport,
  checkCompatibility,
  compareGameVersions,
  type InstalledMod,
  NEOFORGE_FORGE_BRIDGE_VERSION,
  type TargetServer,
} from './compat';
import type { DependencyRef } from './types';

const index = gameVersionIndex();

const server = (overrides: Partial<TargetServer> = {}): TargetServer => ({
  loader: 'fabric',
  gameVersion: '1.21.1',
  ...overrides,
});

/** Codes only — assertions read better against a set of codes than against prose. */
const codes = (report: CompatReport): string[] => [
  ...report.blockers.map((f) => f.code),
  ...report.warnings.map((f) => f.code),
  ...report.notes.map((f) => f.code),
];

const blockerCodes = (report: CompatReport): string[] => report.blockers.map((f) => f.code);
const warningCodes = (report: CompatReport): string[] => report.warnings.map((f) => f.code);

describe('checkCompatibility — the happy path', () => {
  it('approves a server-side Fabric mod on a matching Fabric server', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion(),
      versionIndex: index,
    });

    expect(report.verdict).toBe('compatible');
    expect(report.score).toBe(100);
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.missingDependencies).toEqual([]);
    expect(report.conflicts).toEqual([]);
  });

  it('never resolves compatibility from the project-level historical union', () => {
    // Sodium's project object claims 1.16.3 → 26.2 and three loaders. No single file does.
    // The candidate *version* only supports 1.20.1/forge, and that is what must decide.
    const report = checkCompatibility({
      server: server({ loader: 'fabric', gameVersion: '1.21.1' }),
      project: makeProject({
        loaders: ['fabric', 'forge', 'neoforge', 'quilt'],
        gameVersions: ['1.16.5', '1.20.1', '1.21.1', '26.2'],
      }),
      version: makeVersion({ loaders: ['forge'], gameVersions: ['1.20.1'] }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('incompatible');
    expect(blockerCodes(report)).toContain('loader_not_accepted');
    expect(blockerCodes(report)).toContain('game_version_mismatch');
  });
});

describe('loader family', () => {
  it('blocks a Bukkit plugin on Fabric and explains it is a different runtime', () => {
    const report = checkCompatibility({
      server: server({ loader: 'fabric' }),
      project: makeProject({ kind: 'plugin', title: 'EssentialsX' }),
      version: makeVersion({ loaders: ['bukkit', 'spigot', 'paper'] }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('incompatible');
    expect(blockerCodes(report)).toContain('loader_family_mismatch');
    const finding = report.blockers.find((f) => f.code === 'loader_family_mismatch');
    expect(finding?.detail).toMatch(/plugin platform/);
    expect(finding?.fix).toMatch(/Fabric\/NeoForge mod/);
  });

  it('blocks a Fabric mod on Paper', () => {
    const report = checkCompatibility({
      server: server({ loader: 'paper' }),
      project: makeProject(),
      version: makeVersion({ loaders: ['fabric'] }),
      versionIndex: index,
    });

    expect(blockerCodes(report)).toContain('loader_family_mismatch');
    expect(report.blockers[0]?.fix).toMatch(/Bukkit\/Spigot\/Paper plugin/);
  });

  it('accepts Fabric mods on Quilt, and says so rather than leaving it to luck', () => {
    const report = checkCompatibility({
      server: server({ loader: 'quilt' }),
      project: makeProject(),
      version: makeVersion({ loaders: ['fabric'] }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('compatible');
    expect(codes(report)).toContain('loader_accepted_by_inheritance');
  });

  it.each([
    ['purpur', 'paper'],
    ['purpur', 'spigot'],
    ['folia', 'paper'],
    ['paper', 'bukkit'],
  ] as const)('accepts a %s server loading %s plugins', (loader, declared) => {
    const report = checkCompatibility({
      server: server({ loader, gameVersion: '1.21.1' }),
      project: makeProject({ kind: 'plugin' }),
      version: makeVersion({ loaders: [declared] }),
      versionIndex: index,
    });
    expect(report.verdict).toBe('compatible');
  });

  it('does not let a Spigot server load Paper-only plugins', () => {
    // Inheritance is one-directional: Paper implements Spigot's API, not the reverse.
    const report = checkCompatibility({
      server: server({ loader: 'spigot' }),
      project: makeProject({ kind: 'plugin' }),
      version: makeVersion({ loaders: ['paper'] }),
      versionIndex: index,
    });
    expect(blockerCodes(report)).toContain('loader_not_accepted');
  });

  it('blocks everything on vanilla except data packs', () => {
    const modReport = checkCompatibility({
      server: server({ loader: 'vanilla' }),
      project: makeProject(),
      version: makeVersion({ loaders: ['fabric'] }),
      versionIndex: index,
    });
    expect(blockerCodes(modReport)).toContain('vanilla_server_cannot_load_content');

    const datapackReport = checkCompatibility({
      server: server({ loader: 'vanilla' }),
      project: makeProject({ kind: 'datapack' }),
      version: makeVersion({ loaders: [], gameVersions: ['1.21.1'] }),
      versionIndex: index,
    });
    expect(datapackReport.verdict).toBe('compatible');
    expect(codes(datapackReport)).toContain('datapack_content');
  });

  it('grades an undeclared loader as unknown rather than compatible', () => {
    // CurseForge omits the loader pseudo-version on loader-agnostic and older jars.
    const report = checkCompatibility({
      server: server(),
      project: makeProject({ provider: 'curseforge' }),
      version: makeVersion({ provider: 'curseforge', loaders: [] }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('unknown');
    expect(report.blockers).toEqual([]);
    expect(codes(report)).toContain('loader_undeclared');
  });
});

describe('the NeoForge / Forge 1.20.1 boundary', () => {
  it('runs Forge 1.20.1 files on a NeoForge 1.20.1 server', () => {
    const report = checkCompatibility({
      server: server({ loader: 'neoforge', gameVersion: NEOFORGE_FORGE_BRIDGE_VERSION }),
      project: makeProject(),
      version: makeVersion({ loaders: ['forge'], gameVersions: ['1.20.1'] }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('compatible');
    expect(codes(report)).toContain('loader_neoforge_accepts_forge_1_20_1');
    expect(report.blockers).toEqual([]);
  });

  it('warns rather than blocks in the reverse direction on 1.20.1', () => {
    // NeoForge added APIs during 1.20.1 that Forge never had, so this usually works but is not
    // guaranteed. "Usually" is a warning, never a silent pass and never a blocker.
    const report = checkCompatibility({
      server: server({ loader: 'forge', gameVersion: NEOFORGE_FORGE_BRIDGE_VERSION }),
      project: makeProject(),
      version: makeVersion({ loaders: ['neoforge'], gameVersions: ['1.20.1'] }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('compatible_with_warnings');
    expect(warningCodes(report)).toContain('loader_forge_accepts_neoforge_1_20_1');
  });

  it.each(['1.20.2', '1.20.4', '1.21.1', '26.2'])(
    'blocks the Forge/NeoForge crossover at %s',
    (gameVersion) => {
      const forward = checkCompatibility({
        server: server({ loader: 'neoforge', gameVersion }),
        project: makeProject(),
        version: makeVersion({ loaders: ['forge'], gameVersions: [gameVersion] }),
        versionIndex: index,
      });
      expect(forward.verdict).toBe('incompatible');
      expect(blockerCodes(forward)).toContain('loader_not_accepted');

      const reverse = checkCompatibility({
        server: server({ loader: 'forge', gameVersion }),
        project: makeProject(),
        version: makeVersion({ loaders: ['neoforge'], gameVersions: [gameVersion] }),
        versionIndex: index,
      });
      expect(reverse.verdict).toBe('incompatible');
      expect(blockerCodes(reverse)).toContain('loader_not_accepted');
    }
  );

  it('does not apply the bridge to 1.20 or 1.20.0-adjacent versions', () => {
    // The bridge is a single version, not "the 1.20 line".
    const report = checkCompatibility({
      server: server({ loader: 'neoforge', gameVersion: '1.20' }),
      project: makeProject(),
      version: makeVersion({ loaders: ['forge'], gameVersions: ['1.20'] }),
      versionIndex: index,
    });
    expect(report.verdict).toBe('incompatible');
  });
});

describe('game versions', () => {
  it('blocks a mismatch and names the newest supported version', () => {
    const report = checkCompatibility({
      server: server({ gameVersion: '1.21.1' }),
      project: makeProject(),
      version: makeVersion({ gameVersions: ['1.20.1', '1.20.4'] }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('incompatible');
    const finding = report.blockers.find((f) => f.code === 'game_version_mismatch');
    expect(finding?.detail).toContain('supports up to Minecraft 1.20.4');
    expect(finding?.evidence?.supported).toEqual(['1.20.1', '1.20.4']);
  });

  it('orders calendar versions above the 1.x line using the index, not string parsing', () => {
    // Naive comparison puts "1.21.11" above "26.2" (or sorts "26.2" below "1.21.11"
    // lexicographically). The index knows 26.2 is newer.
    expect(compareGameVersions('1.21.11', '26.2', index)).toBeLessThan(0);
    expect(compareGameVersions('26.1', '26.2', index)).toBeLessThan(0);
    expect(compareGameVersions('1.20.1', '1.21.1', index)).toBeLessThan(0);

    const report = checkCompatibility({
      server: server({ gameVersion: '26.2' }),
      project: makeProject(),
      version: makeVersion({ gameVersions: ['1.21.10', '1.21.11'] }),
      versionIndex: index,
    });
    const finding = report.blockers.find((f) => f.code === 'game_version_mismatch');
    expect(finding?.detail).toContain('supports up to Minecraft 1.21.11');
    expect(finding?.detail).toContain('which is newer');
  });

  it('says "needs a newer Minecraft" when the server is behind', () => {
    const report = checkCompatibility({
      server: server({ gameVersion: '1.20.1' }),
      project: makeProject(),
      version: makeVersion({ gameVersions: ['26.1', '26.2'] }),
      versionIndex: index,
    });
    const finding = report.blockers.find((f) => f.code === 'game_version_mismatch');
    expect(finding?.detail).toContain('needs Minecraft 26.1 or later');
  });

  it('recognises a version it supports on both sides but skips', () => {
    const report = checkCompatibility({
      server: server({ gameVersion: '1.21.1' }),
      project: makeProject(),
      version: makeVersion({ gameVersions: ['1.20.1', '26.2'] }),
      versionIndex: index,
    });
    const finding = report.blockers.find((f) => f.code === 'game_version_mismatch');
    expect(finding?.detail).toMatch(/supports 1\.20\.1 and 26\.2 but not 1\.21\.1/);
  });

  it('flags a server version the index has never heard of', () => {
    const report = checkCompatibility({
      server: server({ gameVersion: '27.9' }),
      project: makeProject(),
      version: makeVersion({ gameVersions: ['26.2'] }),
      versionIndex: index,
    });
    expect(codes(report)).toContain('game_version_unknown_to_index');
  });

  it('still works without an index, falling back to parsing', () => {
    const report = checkCompatibility({
      server: server({ gameVersion: '1.21.1' }),
      project: makeProject(),
      version: makeVersion({ gameVersions: ['1.20.1'] }),
    });
    expect(report.verdict).toBe('incompatible');
    expect(blockerCodes(report)).toContain('game_version_mismatch');
  });

  it('grades an undeclared game version list as unknown', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({ gameVersions: [] }),
      versionIndex: index,
    });
    expect(report.verdict).toBe('unknown');
    expect(codes(report)).toContain('game_version_undeclared');
  });
});

describe('client-only content', () => {
  it('blocks a mod the author marked unsupported on the server', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({
        title: 'Sodium',
        clientSide: 'required',
        serverSide: 'unsupported',
        environment: 'client_only',
      }),
      version: makeVersion(),
      versionIndex: index,
    });

    expect(report.verdict).toBe('incompatible');
    expect(blockerCodes(report)).toContain('client_only_mod');
    expect(report.blockers[0]?.fix).toMatch(/Minecraft client/);
  });

  it('allows a mod that is optional on the server', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({
        clientSide: 'required',
        serverSide: 'optional',
        environment: 'client_only_server_optional',
      }),
      version: makeVersion(),
      versionIndex: index,
    });
    expect(report.verdict).toBe('compatible');
  });

  it.each([
    ['Complementary Shaders', 'shaders'],
    ['Xaeros Minimap', 'minimap'],
    ['Better HUD', 'HUD/overlay'],
    ['Faithful Texture Pack', 'resource pack'],
    ['Zoomify', 'camera/zoom'],
  ])('warns (never blocks) on the name heuristic for %s', (title, label) => {
    const report = checkCompatibility({
      server: server(),
      // CurseForge publishes no side metadata at all — this is the only signal available.
      project: makeProject({
        provider: 'curseforge',
        title,
        clientSide: 'unknown',
        serverSide: 'unknown',
        environment: 'unknown',
      }),
      version: makeVersion({ provider: 'curseforge' }),
      versionIndex: index,
    });

    expect(report.blockers).toEqual([]);
    expect(report.verdict).toBe('compatible_with_warnings');
    const finding = report.warnings.find((f) => f.code === 'client_only_suspected');
    expect(finding?.heuristic).toBe(true);
    expect(finding?.evidence?.hint).toBe(label);
  });

  it('suppresses the heuristic when the file itself carries a Server tag', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({
        provider: 'curseforge',
        title: 'Dynamic Minimap',
        clientSide: 'unknown',
        serverSide: 'unknown',
        environment: 'unknown',
      }),
      version: makeVersion({ provider: 'curseforge', environmentTags: ['client', 'server'] }),
      versionIndex: index,
    });

    expect(warningCodes(report)).not.toContain('client_only_suspected');
    expect(codes(report)).toContain('server_side_from_file_tags');
    expect(report.verdict).toBe('compatible');
  });

  it('notes, without warning, when nothing at all is known about the side', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({
        provider: 'curseforge',
        title: 'Iron Chests',
        summary: 'More chests.',
        categories: ['storage'],
        clientSide: 'unknown',
        serverSide: 'unknown',
        environment: 'unknown',
      }),
      version: makeVersion({ provider: 'curseforge' }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('compatible');
    expect(codes(report)).toContain('server_side_unknown');
  });
});

describe('content kinds that are not server mods', () => {
  it('blocks a modpack', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({ kind: 'modpack' }),
      version: makeVersion(),
      versionIndex: index,
    });
    expect(blockerCodes(report)).toContain('modpack_not_installable');
  });

  it.each(['resourcepack', 'shader'] as const)('blocks %s content on a server', (kind) => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({ kind }),
      version: makeVersion(),
      versionIndex: index,
    });
    expect(blockerCodes(report)).toContain('client_side_content');
  });
});

describe('dependencies', () => {
  const dep = (overrides: Partial<DependencyRef> = {}): DependencyRef => ({
    provider: 'modrinth',
    projectId: 'P7dR8mSH',
    versionId: null,
    fileName: null,
    kind: 'required',
    ...overrides,
  });

  it('blocks on a missing required dependency and returns a resolvable ref', () => {
    const required = dep();
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({ dependencies: [required] }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('incompatible');
    expect(blockerCodes(report)).toContain('dependency_missing');
    expect(report.missingDependencies).toEqual([required]);
  });

  it('is satisfied when the dependency is already installed', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({ dependencies: [dep()] }),
      installed: [{ provider: 'modrinth', projectId: 'P7dR8mSH', title: 'Fabric API' }],
      versionIndex: index,
    });

    expect(report.verdict).toBe('compatible');
    expect(report.missingDependencies).toEqual([]);
  });

  it('blocks a filename-only required dependency it can never resolve', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({
        dependencies: [dep({ projectId: null, versionId: null, fileName: 'somelib-1.2.jar' })],
      }),
      versionIndex: index,
    });

    expect(blockerCodes(report)).toContain('dependency_unresolvable');
    // Nothing to auto-add — it is not on the provider at all.
    expect(report.missingDependencies).toEqual([]);
    expect(report.blockers[0]?.fix).toContain('somelib-1.2.jar');
  });

  it('blocks a declared incompatibility against an installed mod', () => {
    // The real Embeddium-vs-Sodium-forks edge: project-wide, version_id null.
    const report = checkCompatibility({
      server: server(),
      project: makeProject({ projectId: 'u58R1TMW', slug: 'embeddium', title: 'Embeddium' }),
      version: makeVersion({
        projectId: 'u58R1TMW',
        dependencies: [dep({ projectId: 'AANobbMI', kind: 'incompatible' })],
      }),
      installed: [{ provider: 'modrinth', projectId: 'AANobbMI', title: 'Sodium' }],
      versionIndex: index,
    });

    expect(report.verdict).toBe('incompatible');
    expect(blockerCodes(report)).toContain('dependency_incompatible');
    expect(report.conflicts).toContainEqual({
      reason: 'declared_incompatible',
      provider: 'modrinth',
      projectId: 'AANobbMI',
      title: 'Sodium',
    });
    // The same pair also trips the renderer singleton rule. Both firing is correct: the declared
    // edge is the authority and the role rule is the explanation of *why* the author declared it.
    expect(report.conflicts).toContainEqual({
      reason: 'singleton_role',
      provider: 'modrinth',
      projectId: 'AANobbMI',
      title: 'Sodium',
      role: 'renderer',
    });
  });

  it('only notes an incompatibility with something that is not installed', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({
        dependencies: [dep({ projectId: '4ZqxOvjD', kind: 'incompatible' })],
      }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('compatible');
    expect(codes(report)).toContain('dependency_incompatible_absent');
    expect(report.conflicts).toEqual([]);
  });

  it('detects the conflict when the *installed* mod is the one declaring it', () => {
    // Embeddium declares incompatible against Sodium. Sodium declares nothing. Checking only
    // the candidate's edges misses this entirely.
    const report = checkCompatibility({
      server: server(),
      project: makeProject({ projectId: 'AANobbMI', title: 'Sodium' }),
      version: makeVersion({ projectId: 'AANobbMI', dependencies: [] }),
      installed: [
        {
          provider: 'modrinth',
          projectId: 'u58R1TMW',
          title: 'Embeddium',
          dependencies: [dep({ projectId: 'AANobbMI', kind: 'incompatible' })],
        },
      ],
      versionIndex: index,
    });

    expect(report.verdict).toBe('incompatible');
    expect(blockerCodes(report)).toContain('installed_declares_incompatible');
    expect(report.conflicts[0]?.projectId).toBe('u58R1TMW');
  });

  it('does not try to install an embedded dependency', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({ dependencies: [dep({ kind: 'embedded' })] }),
      versionIndex: index,
    });

    expect(report.missingDependencies).toEqual([]);
    expect(codes(report)).toContain('dependency_embedded');
    expect(report.verdict).toBe('compatible');
  });

  it('ignores tool dependencies entirely and summarises optional ones', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({
        dependencies: [
          dep({ kind: 'tool', projectId: 'tool1' }),
          dep({ kind: 'optional', projectId: 'opt1' }),
          dep({ kind: 'optional', projectId: 'opt2' }),
        ],
      }),
      versionIndex: index,
    });

    expect(report.missingDependencies).toEqual([]);
    const note = report.notes.find((f) => f.code === 'dependency_optional_available');
    expect(note?.evidence?.optionalCount).toBe(2);
    expect(report.verdict).toBe('compatible');
  });
});

describe('what is already installed', () => {
  const installed = (overrides: Partial<InstalledMod> = {}): InstalledMod => ({
    provider: 'modrinth',
    projectId: 'AANobbMI',
    slug: 'test-mod',
    title: 'Test Mod',
    ...overrides,
  });

  it('blocks installing a project twice', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({ versionId: 'v2' }),
      installed: [installed({ versionId: 'v1' })],
      versionIndex: index,
    });

    expect(report.verdict).toBe('incompatible');
    expect(blockerCodes(report)).toContain('already_installed');
    expect(report.blockers[0]?.detail).toMatch(/different version/);
    expect(report.conflicts[0]?.reason).toBe('already_installed');
  });

  it('warns about the same project installed from the other provider', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({ slug: 'jei', title: 'Just Enough Items' }),
      version: makeVersion(),
      installed: [
        { provider: 'curseforge', projectId: '238222', slug: 'jei', title: 'Just Enough Items' },
      ],
      versionIndex: index,
    });

    expect(report.blockers).toEqual([]);
    expect(warningCodes(report)).toContain('duplicate_cross_provider');
    expect(report.conflicts[0]?.reason).toBe('duplicate_cross_provider');
  });

  it('warns when two mods claim the same singleton role', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({ slug: 'sodium', title: 'Sodium' }),
      version: makeVersion(),
      installed: [
        { provider: 'curseforge', projectId: '908741', slug: 'embeddium', title: 'Embeddium' },
      ],
      versionIndex: index,
    });

    const finding = report.warnings.find((f) => f.code === 'singleton_role_conflict');
    expect(finding).toBeDefined();
    expect(finding?.heuristic).toBe(true);
    expect(
      report.conflicts.some((c) => c.reason === 'singleton_role' && c.role === 'renderer')
    ).toBe(true);
  });

  it('does not invent a singleton conflict between unrelated mods', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({ slug: 'sodium', title: 'Sodium' }),
      version: makeVersion(),
      installed: [{ provider: 'modrinth', projectId: 'X', slug: 'waystones', title: 'Waystones' }],
      versionIndex: index,
    });
    expect(warningCodes(report)).not.toContain('singleton_role_conflict');
  });
});

describe('availability and release channel', () => {
  it('blocks a CurseForge file the author opted out of distributing, with a manual fix', () => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject({
        provider: 'curseforge',
        projectUrl: 'https://www.curseforge.com/minecraft/mc-mods/mineshafts-and-monsters',
        clientSide: 'unknown',
        serverSide: 'unknown',
        environment: 'unknown',
      }),
      version: makeVersion({
        provider: 'curseforge',
        downloadable: false,
        downloadBlockedReason:
          'The author has disabled third-party downloads for this project. Download the file from CurseForge and add it manually.',
        file: { name: 'blocked.jar', url: null, size: 100, sha1: null, sha512: null },
      }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('incompatible');
    const finding = report.blockers.find((f) => f.code === 'not_downloadable');
    expect(finding?.detail).toMatch(/disabled third-party downloads/);
    expect(finding?.fix).toContain('curseforge.com');
  });

  it.each([
    ['beta', 'prerelease_beta'],
    ['alpha', 'prerelease_alpha'],
  ] as const)('warns about a %s build', (channel, code) => {
    const report = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({ channel }),
      versionIndex: index,
    });

    expect(report.verdict).toBe('compatible_with_warnings');
    expect(warningCodes(report)).toContain(code);
    expect(report.score).toBeLessThan(100);
  });
});

describe('scoring and verdict derivation', () => {
  it('drops the score for each finding and floors at zero', () => {
    const clean = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion(),
      versionIndex: index,
    });
    expect(clean.score).toBe(100);

    const oneWarning = checkCompatibility({
      server: server(),
      project: makeProject(),
      version: makeVersion({ channel: 'beta' }),
      versionIndex: index,
    });
    expect(oneWarning.score).toBeLessThan(clean.score);

    const disaster = checkCompatibility({
      server: server({ loader: 'paper', gameVersion: '1.8.9' }),
      project: makeProject({ kind: 'modpack' }),
      version: makeVersion({ channel: 'alpha', downloadable: false, gameVersions: ['26.2'] }),
      versionIndex: index,
    });
    expect(disaster.score).toBe(0);
    expect(disaster.verdict).toBe('incompatible');
  });

  it('prefers incompatible over unknown when both apply', () => {
    const report = checkCompatibility({
      server: server({ loader: 'paper' }),
      project: makeProject(),
      // Loader is declared and wrong (blocker); game version is undeclared (unknown).
      version: makeVersion({ loaders: ['fabric'], gameVersions: [] }),
      versionIndex: index,
    });
    expect(report.verdict).toBe('incompatible');
    expect(report.notes.map((f) => f.code)).toContain('game_version_undeclared');
  });

  it('is a pure function — the same input twice gives the same report', () => {
    const input = {
      server: server(),
      project: makeProject({
        title: 'Shaders Plus',
        provider: 'curseforge' as const,
        environment: 'unknown' as const,
      }),
      version: makeVersion({ channel: 'beta' as const }),
      versionIndex: index,
    };
    expect(checkCompatibility(input)).toEqual(checkCompatibility(input));
  });
});
